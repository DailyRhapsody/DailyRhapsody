import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { buildEntryOutline } from "@/lib/entry-outline";
import type { EntryOutlineItem } from "@/components/entries/types";
import { getDiaries, isNotionConfigured, type Diary } from "@/lib/notion";
import { loadLocalDiaries } from "@/lib/dev-snapshot";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { stripPrivateMarkers } from "@/lib/share-card";

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

  // 本地预览：没有 Notion 凭证时，非生产环境回落到本机脱敏只读快照（data/diaries.json），
  // 让 /blog 能带真实文章渲染。生产没有凭证仍然按配置错误处理，行为不变。
  const localSnapshot = isNotionConfigured() ? null : await loadLocalDiaries();

  if (!isNotionConfigured() && !localSnapshot) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Notion is not configured" }, { status: 503 })
    );
  }

  const { searchParams } = new URL(req.url);
  const limitParam = searchParams.get("limit");

  let diaries: Diary[];
  try {
    diaries = localSnapshot ?? (await getDiaries());
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
      // 搜索只匹配读者能看到的文字：转换层的私有标记与引用前缀不参与匹配，
      // 否则搜 "notion" / "toggle" 会命中所有含折叠块或标注的文章。
      const text = [stripPrivateMarkers(d.summary ?? ""), d.location ?? "", (d.tags ?? []).join(" ")].join(" ");
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
    outline?: EntryOutlineItem[];
  } = { items, total, hasMore };

  if (offset === 0) {
    body.tagCounts = getTagCounts(visible);
    body.dates = [...new Set(visible.map((d) => d.date))];
    // 时间轴大纲：用 filtered（已剔除访客不可见的私密文章并套用 tag/搜索），与 total 同口径
    if (searchParams.get("outline") === "1") body.outline = buildEntryOutline(filtered);
  }

  return withAntiScrapeHeaders(NextResponse.json(body));
}
