import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  getReferenceItems,
  isReferenceConfigured,
  type ReferenceItem,
} from "@/lib/notion-reference";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";

// SWR 后台重拉（waitUntil）跑在本次函数调用里，受 maxDuration 约束；与 /api/diaries 对齐，
// 让全量刷新能在截断前写进缓存。
export const maxDuration = 300;

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 30;

function getTagCounts(items: ReferenceItem[]): { name: string; value: number }[] {
  const count = new Map<string, number>();
  for (const it of items) {
    for (const t of it.tags) {
      count.set(t, (count.get(t) ?? 0) + 1);
    }
  }
  return Array.from(count.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "reference:list",
    limit: 60,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  if (!isReferenceConfigured()) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Reference DB is not configured" }, { status: 503 })
    );
  }

  let items: ReferenceItem[];
  try {
    items = await getReferenceItems();
  } catch (e) {
    console.error("[reference] getReferenceItems failed:", e);
    return withAntiScrapeHeaders(
      NextResponse.json(
        { error: "无法读取 reference", detail: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      )
    );
  }

  const admin = await isAdmin();
  const visible = admin ? items : items.filter((d) => d.isPublic !== false);

  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    Math.max(1, Number(searchParams.get("limit")) || DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const tag = searchParams.get("tag") ?? undefined;
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();

  let filtered = tag
    ? visible.filter((d) => d.tags.includes(tag))
    : visible;
  if (q) {
    filtered = filtered.filter((d) => {
      const text = [d.name, d.source, d.tags.join(" ")].join(" ");
      return text.toLowerCase().includes(q);
    });
  }
  const total = filtered.length;
  const sliced = filtered.slice(offset, offset + limit);
  const hasMore = offset + sliced.length < total;

  const body: {
    items: ReferenceItem[];
    total: number;
    hasMore: boolean;
    tagCounts?: { name: string; value: number }[];
  } = { items: sliced, total, hasMore };

  if (offset === 0) {
    body.tagCounts = getTagCounts(visible);
  }

  return withAntiScrapeHeaders(NextResponse.json(body));
}
