import { NextResponse } from "next/server";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { listMoments, isMomentsConfigured } from "@/lib/notion-moments";

export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "moments:list",
    limit: 90,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  if (!isMomentsConfigured()) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Moments not configured" }, { status: 503 })
    );
  }

  const url = new URL(req.url);
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  try {
    const { items, total, hasMore, outline } = await listMoments({
      limit,
      offset,
      includePrivate: false,
      // 时间轴大纲只随首页下发
      withOutline: offset === 0 && url.searchParams.get("outline") === "1",
    });

    return withAntiScrapeHeaders(
      NextResponse.json({
        items,
        total,
        hasMore,
        nextOffset: offset + items.length,
        ...(outline ? { outline } : {}),
      })
    );
  } catch (e) {
    console.error("[moments] list", e);
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "无法读取动态" }, { status: 503 })
    );
  }
}

// POST removed — moments are now managed in Notion
