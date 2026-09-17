/**
 * On-demand revalidation endpoint.
 *
 * 调用方式（仅 POST）：
 *   curl -X POST -H "Authorization: Bearer $REVALIDATE_SECRET" \
 *        https://www.tengjun.org/api/revalidate
 *
 * Notion 数据库自动化（Send webhook）可在「Add custom header」里填
 *   X-Revalidate-Secret: <secret>
 * 自动化是否允许自定义 Authorization 头官方没有写明，两种头都接受。
 *
 * 用途：
 * 1. 把 Upstash 中的 Notion 数据缓存（diaries / moments / reference）标记为过期：
 *    保留旧数据，下一次访问秒回旧数据并在后台重拉。不再直接删除——删除后首位访客
 *    要同步冷拉 80s 以上，前端 30s 超时显示「暂无文章」，批量修改时还会反复冷拉。
 * 2. 重新验证 Next.js 内置页面缓存
 *
 * 安全要点：
 * - secret 仅从 Authorization 头读取，不放 query string（避免落入 Vercel
 *   access log / proxy log / Referer / 浏览器历史）。
 * - 仅 POST。早先版本 GET 直接代理 POST，结果是任何带 secret 的链接、
 *   <img src=...>、CSRF 都能触发缓存击穿 DoS。
 * - 错误 message 不回显内部信息（避免泄漏 Notion / Upstash 内部错误链）。
 */

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { markDiariesCacheStale } from "@/lib/notion";
import { markMomentsCacheStale } from "@/lib/notion-moments";
import { markReferenceCacheStale } from "@/lib/notion-reference";

// 标记过期后在本次调用里用 waitUntil 后台重拉（日记全量约 80-100s）
export const maxDuration = 300;

function extractProvidedSecret(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return req.headers.get("x-revalidate-secret")?.trim() || null;
}

export async function POST(req: NextRequest) {
  const expected = process.env.REVALIDATE_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const provided = extractProvidedSecret(req);
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await markDiariesCacheStale();
    await markMomentsCacheStale();
    await markReferenceCacheStale();
    revalidatePath("/", "layout");
    revalidatePath("/reference", "layout");
    return NextResponse.json({ revalidated: true, now: Date.now() });
  } catch (error) {
    // 不回显具体错误信息给客户端（避免泄漏 Notion / Upstash 内部错误链）
    console.warn("[revalidate] failed:", error);
    return NextResponse.json({ error: "Revalidation failed" }, { status: 500 });
  }
}

/** 健康检查端点（不携带 secret 时返回 OK，不触发任何动作）。 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST with Authorization: Bearer <secret> or X-Revalidate-Secret: <secret>",
  });
}
