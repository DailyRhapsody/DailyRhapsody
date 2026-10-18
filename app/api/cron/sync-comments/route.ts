/**
 * 评论同步的待补队列：正向创建或删除在后台失败后，由这里重试。
 *
 * 独立成一条 cron 而不是塞进 warm-cache：那边全量拉 Notion 已经能跑到 290s，
 * 再加重试会把 300s 预算挤爆，两条任务互相拖累。
 */
import { NextResponse, type NextRequest } from "next/server";
import { drainPending } from "@/lib/comment-sync";

export const maxDuration = 60;

/** 单次最多处理多少条；Notion 约 3 req/s，20 条留足余量 */
const BATCH = 20;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const processed = await drainPending(BATCH);
  return NextResponse.json({ ok: true, processed });
}
