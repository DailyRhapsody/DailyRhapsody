/**
 * Reference 文件下载：/api/download/reference/[id]
 *
 * 为什么不放在 /api/reference/*：那边所有 GET 都被 proxy.ts 当成受保护 public API，
 * 必须有 dr_gate。下载链接会被新标签页、外部引用、分享直接打开，冷启动拿不到 gate，
 * 会返回 403 JSON 而不是文件。这里独立前缀，只做公开性与许可校验 + 限流。
 *
 * 下载走浏览器原生能力：先记一次数，再 302 到文件地址。PDF 通常内联打开，
 * 用户用浏览器自带下载按钮另存；302 上的 Content-Disposition 不会生效，别指望它。
 */

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import {
  getCachedReferenceItems,
  getReferenceAttachmentUrl,
  getReferenceItems,
  isReferenceConfigured,
  recordReferenceDownload,
  type ReferenceItem,
} from "@/lib/notion-reference";
import { withAntiScrapeHeaders } from "@/lib/request-guard";
import { limitByIp } from "@/lib/upstash-rate-limit";

const PAGE_ID_RE = /^[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return withAntiScrapeHeaders(
    NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } })
  );
}

async function findItem(id: string): Promise<ReferenceItem | null> {
  const cached = await getCachedReferenceItems();
  const items = cached ?? (await getReferenceItems());
  return items.find((item) => item.id === id) ?? null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!PAGE_ID_RE.test(id)) return json({ error: "Not found" }, 404);

  if (!isReferenceConfigured()) return json({ error: "Reference DB is not configured" }, 503);

  if (!(await limitByIp("reference:download", getClientIpFromRequest(req), 30, "1 m"))) {
    return json({ error: "请求太频繁，稍后再试" }, 429);
  }

  const item = await findItem(id);
  if (!item) return json({ error: "Not found" }, 404);

  const admin = await isAdmin();
  if (!admin && !item.isPublic) return json({ error: "Not found" }, 404);

  if (item.license === "link-only") {
    return json(
      {
        error: "该条目仅提供原文链接",
        ...(item.url ? { url: item.url } : {}),
      },
      403
    );
  }
  if (!item.attachment) {
    return json({ error: "该条目没有可下载文件", ...(item.url ? { url: item.url } : {}) }, 404);
  }

  let target: string | null = null;
  if (item.attachment.kind === "external") {
    target = item.attachment.url;
  } else {
    const resolved = await getReferenceAttachmentUrl(item.id);
    target = resolved?.url ?? null;
  }
  if (!target) return json({ error: "文件暂时不可用，请稍后再试" }, 503);

  await recordReferenceDownload(item.id);

  const res = NextResponse.redirect(target, 302);
  // 目标 URL 是临时签名地址；不要把 302 本身写进任何缓存
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return res;
}
