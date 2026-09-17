import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getDiaries, isNotionConfigured, type Diary } from "@/lib/notion";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";

// SWR 后台重拉（waitUntil）跑在本次函数调用里，受 maxDuration 约束。
// 正文抓取按 Retry-After 重试 429 后，全量刷新实测约 80s，与 cron 预热端点一样给足预算。
export const maxDuration = 300;

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 30;

function getTagCounts(diaries: Diary[]): { name: string; value: number }[] {
  const count = new Map<string, number>();
  for (const d of diaries) {
    for (const t of d.tags ?? []) {
      count.set(t, (count.get(t) ?? 0) + 1);
    }
  }
  return Array.from(count.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "diaries:list",
    limit: 60,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  if (!isNotionConfigured()) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Notion is not configured" }, { status: 503 })
    );
  }

  const { searchParams } = new URL(req.url);
  const limitParam = searchParams.get("limit");

  let diaries: Diary[];
  try {
    diaries = await getDiaries();
  } catch (e) {
    console.error("[diaries] getDiaries failed:", e);
    return withAntiScrapeHeaders(
      NextResponse.json(
        { error: "无法读取日记", detail: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      )
    );
  }
  const admin = await isAdmin();
  const visible = admin ? diaries : diaries.filter((d) => d.isPublic !== false);

  if (limitParam == null || limitParam === "") {
    if (!admin) {
      const limit = DEFAULT_PAGE_SIZE;
      const items = visible.slice(0, limit);
      const body = {
        items,
        total: visible.length,
        hasMore: visible.length > items.length,
        tagCounts: getTagCounts(visible),
        dates: [...new Set(visible.map((d) => d.date))],
      };
      return withAntiScrapeHeaders(NextResponse.json(body));
    }
    return withAntiScrapeHeaders(NextResponse.json(visible));
  }

  const limit = Math.min(
    Math.max(1, Number(limitParam) || DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const tag = searchParams.get("tag") ?? undefined;
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();

  let filtered = tag
    ? visible.filter((d) => (d.tags ?? []).includes(tag))
    : visible;
  if (q) {
    filtered = filtered.filter((d) => {
      const text = [d.summary ?? "", d.location ?? "", (d.tags ?? []).join(" ")].join(" ");
      return text.toLowerCase().includes(q);
    });
  }
  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  const hasMore = offset + items.length < total;

  const body: {
    items: Diary[];
    total: number;
    hasMore: boolean;
    tagCounts?: { name: string; value: number }[];
    dates?: string[];
  } = { items, total, hasMore };

  if (offset === 0) {
    body.tagCounts = getTagCounts(visible);
    body.dates = [...new Set(visible.map((d) => d.date))];
  }

  return withAntiScrapeHeaders(NextResponse.json(body));
}
