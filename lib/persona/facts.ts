import type { Diary } from "@/lib/notion";
import { postTitle } from "@/lib/persona/retrieve";

/**
 * 博客概况：每轮对话按当前日记缓存实时统计，让数字人答得出「多少篇」「最早哪天」这类问题。
 * 数据与页面上显示的同源，不额外请求。
 */
export type BlogFacts = {
  total: number;
  privateCount: number;
  first: string;
  last: string;
  perYear: [string, number][];
  recent: { date: string; title: string; href: string }[];
  topTags: [string, number][];
};

const RECENT_COUNT = 5;
const TOP_TAG_COUNT = 12;

/**
 * posts：计入统计的文章（访客为公开文章，本人模式含私密）。
 * hide：访客回避的主题，只影响「最近几篇」与「常用标签」的列举，不影响篇数。
 */
export function buildBlogFacts(
  posts: Diary[],
  hide: { tags: Set<string>; ids: Set<string> },
  privateCount = 0,
): BlogFacts | null {
  if (posts.length === 0) return null;
  const dates = posts.map((d) => d.date).filter(Boolean).sort();
  const years = new Map<string, number>();
  for (const d of dates) years.set(d.slice(0, 4), (years.get(d.slice(0, 4)) ?? 0) + 1);

  const hidden = (d: Diary) => hide.ids.has(d.id) || !!d.tags?.some((t) => hide.tags.has(t));
  const recent = [...posts]
    .filter((d) => !hidden(d))
    .sort((a, b) => (b.publishedAt ?? b.date).localeCompare(a.publishedAt ?? a.date))
    .slice(0, RECENT_COUNT)
    .map((d) => ({ date: d.date, title: postTitle(d) || "（无标题）", href: `/blog#entry-${d.id}` }));

  const tags = new Map<string, number>();
  for (const d of posts) for (const t of d.tags ?? []) if (!hide.tags.has(t)) tags.set(t, (tags.get(t) ?? 0) + 1);
  const topTags = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_TAG_COUNT);

  return {
    total: posts.length,
    privateCount,
    first: dates[0] ?? "",
    last: dates[dates.length - 1] ?? "",
    perYear: [...years.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    recent,
    topTags,
  };
}

export function renderBlogFacts(f: BlogFacts): string {
  const lines = [
    "## 博客概况（按当前数据实时统计）",
    f.privateCount > 0
      ? `- 文章共 ${f.total} 篇，其中私密 ${f.privateCount} 篇、公开 ${f.total - f.privateCount} 篇`
      : `- 公开文章共 ${f.total} 篇`,
    `- 最早一篇写于 ${f.first}，最近一篇写于 ${f.last}`,
    `- 各年篇数：${f.perYear.map(([y, n]) => `${y} 年 ${n} 篇`).join("、")}`,
  ];
  if (f.recent.length) {
    lines.push(`- 最近几篇：${f.recent.map((r) => `[${r.title}](${r.href})（${r.date}）`).join("；")}`);
  }
  if (f.topTags.length) {
    lines.push(`- 常用标签：${f.topTags.map(([t, n]) => `${t} ${n} 篇`).join("、")}`);
  }
  lines.push("被问到篇数、日期、标签这类统计时以这里为准，不要估算。");
  return lines.join("\n");
}
