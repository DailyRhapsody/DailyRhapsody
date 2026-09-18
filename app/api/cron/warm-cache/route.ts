/**
 * Cron 缓存预热端点。
 *
 * 由 vercel.json 的 crons 每日调用一次，强制重拉三个 Notion 数据源并写缓存，
 * 使 Redis key 即便在零流量期间也永不缺席（硬 TTL 48h 对每日一次留出一整天余量）。
 * 新鲜度仍由 SWR 的 5 分钟 stale 阈值负责，本端点只消灭「key 整个消失 →
 * 用户请求承担 20-53s 同步全量冷拉」的窗口。
 *
 * 鉴权：Vercel Cron 自动携带 `Authorization: Bearer ${CRON_SECRET}`（需在项目
 * 环境变量配置 CRON_SECRET）。手动触发也可用同一个头。
 *
 * 该路径不在 proxy.ts 的 matcher 内，middleware 的 bot UA 拦截不会拦掉
 * vercel-cron/1.0 的 UA。
 */

import { NextResponse, type NextRequest } from "next/server";
import { warmDiariesCache } from "@/lib/notion";
import { warmMomentsCache } from "@/lib/notion-moments";
import { warmReferenceCache } from "@/lib/notion-reference";

// 三个数据源顺序全量抓取（diaries 实测 20-53s），显式给足预算
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const result: Record<string, number | string> = {};

  // 顺序执行而不是并发：三个源共享同一 Notion token 的速率配额（约 3 req/s），
  // 并发只会互相拖慢；预热对时延不敏感。diaries 放最后：它连同持锁补跑最长可到约 290s
  // （lib/notion.ts CATCH_UP_DEADLINE_MS），moments / reference 几秒就完，先跑完并释放各自的锁，
  // 不会因为本次调用超时被截断在持锁状态。
  try {
    result.moments = await warmMomentsCache();
  } catch (e) {
    console.warn("[cron/warm-cache] moments failed:", e);
    result.moments = "failed";
  }
  try {
    result.reference = await warmReferenceCache();
  } catch (e) {
    console.warn("[cron/warm-cache] reference failed:", e);
    result.reference = "failed";
  }
  try {
    result.diaries = await warmDiariesCache();
  } catch (e) {
    console.warn("[cron/warm-cache] diaries failed:", e);
    result.diaries = "failed";
  }

  const failed = Object.values(result).includes("failed");
  return NextResponse.json(
    { ...result, tookMs: Date.now() - startedAt },
    { status: failed ? 500 : 200 }
  );
}
