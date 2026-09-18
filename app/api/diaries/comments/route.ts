import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getCommentsMany } from "@/lib/comments-store";
import { getCachedDiaries } from "@/lib/notion";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";

/** 单次最多取几篇 */
const MAX_IDS = 20;

/**
 * 批量读评论：GET /api/diaries/comments?ids=a,b,c
 * 宽屏下每篇有评论的文章都在右侧显示线程，逐篇请求很快会撞上 comments:list 与全局限流
 * （超限会记违规、累计后封 IP），所以前端把可见的几篇攒成一批来取。
 * 只返回日记库里存在的公开篇目（私密篇只对站长）；缓存读不到时访客一律拒绝。
 */
export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "comments:list",
    limit: 40,
    windowMs: 60_000,
  });
  if (blocked) return blocked;
  const ids = [
    ...new Set(
      (new URL(req.url).searchParams.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
  if (ids.length === 0 || ids.length > MAX_IDS) {
    return withAntiScrapeHeaders(NextResponse.json({ error: "Invalid ids" }, { status: 400 }));
  }
  const [admin, diaries] = await Promise.all([isAdmin(), getCachedDiaries()]);
  if (!diaries && !admin) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "服务暂时不可用，请稍后再试" }, { status: 503 })
    );
  }
  const readable = diaries
    ? new Set(diaries.filter((d) => admin || d.isPublic).map((d) => d.id))
    : null;
  const allowed = readable ? ids.filter((id) => readable.has(id)) : ids;
  const threads = await getCommentsMany(allowed);
  return withAntiScrapeHeaders(NextResponse.json({ threads }));
}
