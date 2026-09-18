import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getDiaryById, isNotionConfigured } from "@/lib/notion";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";

// SWR 后台重拉（waitUntil）跑在本次函数调用里，受 maxDuration 约束；与 /api/diaries 对齐，
// 让全量刷新（预算见 lib/notion.ts REFRESH_BUDGET_MS）能在截断前写进缓存。
export const maxDuration = 300;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const blocked = await guardApiRequest(req, {
    scope: "diaries:detail",
    limit: 40,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  if (!isNotionConfigured()) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Notion is not configured" }, { status: 503 })
    );
  }

  const { id } = await params;
  const diary = await getDiaryById(id);

  if (!diary) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Not found" }, { status: 404 })
    );
  }

  const admin = await isAdmin();
  if (!admin && diary.isPublic === false) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Not found" }, { status: 404 })
    );
  }

  return withAntiScrapeHeaders(NextResponse.json(diary));
}
