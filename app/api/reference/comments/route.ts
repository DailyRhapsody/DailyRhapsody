import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getCachedReferenceItems } from "@/lib/notion-reference";
import {
  getReferenceCommentsMany,
  isReferenceCommentsConfigured,
  isReferenceThreadId,
} from "@/lib/reference-comments";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";

const MAX_IDS = 20;

/**
 * 批量读 Reference 评论：GET /api/reference/comments?ids=a,b,c
 * 只返回公开条目；与日记评论完全隔离（独立键空间）。
 */
export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "reference:comments:list",
    limit: 40,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  if (!isReferenceCommentsConfigured()) {
    return withAntiScrapeHeaders(NextResponse.json({ threads: {}, pending: [] }));
  }

  const ids = [
    ...new Set(
      (new URL(req.url).searchParams.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(isReferenceThreadId),
    ),
  ];
  if (ids.length === 0 || ids.length > MAX_IDS) {
    return withAntiScrapeHeaders(NextResponse.json({ error: "Invalid ids" }, { status: 400 }));
  }

  const [admin, items] = await Promise.all([isAdmin(), getCachedReferenceItems()]);
  if (!items && !admin) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "服务暂时不可用，请稍后再试" }, { status: 503 }),
    );
  }
  const readable = new Set(
    (items ?? []).filter((item) => admin || item.isPublic).map((item) => item.id),
  );
  const allowed = ids.filter((id) => readable.has(id));
  const { threads, pending } = await getReferenceCommentsMany(allowed);
  return withAntiScrapeHeaders(NextResponse.json({ threads, pending }));
}
