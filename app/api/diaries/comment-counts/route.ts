import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getCommentCounts } from "@/lib/comments-store";
import { getCachedDiaries } from "@/lib/notion";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";

/** 各篇评论数：列表页一次取回，决定哪几篇在右侧展开评论。私密篇的计数只给站长。 */
export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "comments:counts",
    limit: 30,
    windowMs: 60_000,
  });
  if (blocked) return blocked;
  const [admin, diaries] = await Promise.all([isAdmin(), getCachedDiaries()]);
  // 缓存读不到时不知道哪些篇目公开：返回空，列表页暂不显示评论
  if (!diaries) return withAntiScrapeHeaders(NextResponse.json({ counts: {} }));
  const counts = await getCommentCounts(new Set(diaries.map((d) => d.id)));
  const visible = new Set(diaries.filter((d) => admin || d.isPublic).map((d) => d.id));
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(counts)) if (visible.has(id)) out[id] = n;
  return withAntiScrapeHeaders(NextResponse.json({ counts: out }));
}
