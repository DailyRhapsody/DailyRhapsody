import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { getMoments, isMomentsConfigured } from "@/lib/notion-moments";

// SWR 后台重拉（waitUntil）跑在本次函数调用里，受 maxDuration 约束；与 /api/diaries 对齐，
// 让全量刷新能在截断前写进缓存。
export const maxDuration = 300;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const blocked = await guardApiRequest(req, {
    scope: "moments:one",
    limit: 40,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  if (!isMomentsConfigured()) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Not configured" }, { status: 503 })
    );
  }

  const { id } = await ctx.params;
  const all = await getMoments();
  const m = all.find((x) => x.id === id);
  if (!m) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Not found" }, { status: 404 })
    );
  }

  // 公开性判定与日记、收藏详情一致：非管理员拿不到 Public=false 的动态，
  // 返回 404 而不是 403，避免用状态码区分「不存在」与「存在但私密」。
  const admin = await isAdmin();
  if (!admin && m.isPublic === false) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Not found" }, { status: 404 })
    );
  }

  return withAntiScrapeHeaders(NextResponse.json(m));
}

// PUT/DELETE removed — moments are managed in Notion
export async function PUT() {
  return NextResponse.json(
    { error: "Moments are now managed in Notion. Please edit there." },
    { status: 410 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: "Moments are now managed in Notion. Please delete there." },
    { status: 410 }
  );
}
