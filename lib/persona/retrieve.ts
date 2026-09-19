import type { Diary } from "@/lib/notion";
import type { PersonaNote } from "@/lib/persona/types";

/**
 * 轻量检索：给本轮问题挑几段最相关的原文塞进上下文。
 *
 * 不用向量库、不依赖 embedding API：中文按字二元组、英文按词切分，
 * 用 IDF 加权的重合度打分。日记总量几百篇，每次请求全量打分在十毫秒量级；
 * 索引按快照在实例内存里缓存 5 分钟。
 */

export type Snippet = {
  source: "blog" | "note";
  id: string;
  title: string;
  date?: string;
  /** 站内链接，仅博客原文有 */
  href?: string;
  text: string;
};

type Doc = Snippet & { full: string; grams: Map<string, number> };

const INDEX_TTL_MS = 5 * 60_000;
const SNIPPET_CHARS = 700;

let cached: { at: number; sig: string; docs: Doc[]; df: Map<string, number> } | null = null;

function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9][a-z0-9+#._-]{1,}/g) ?? []) out.push(w);
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function countGrams(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokenize(text)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** 正文里的图片是 /api/media 代理路径，对模型没有意义，检索前剥掉 */
function cleanBody(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^#+\s*/, "").slice(0, 40);
}

function buildIndex(diaries: Diary[], notes: PersonaNote[]) {
  const docs: Doc[] = [];
  for (const d of diaries) {
    const full = cleanBody(d.summary ?? "");
    if (!full) continue;
    docs.push({
      source: "blog",
      id: d.id,
      title: firstLine(full),
      date: d.date,
      href: `/blog#entry-${d.id}`,
      text: "",
      full,
      grams: countGrams(full),
    });
  }
  for (const n of notes) {
    const full = n.text.trim();
    if (!full) continue;
    docs.push({
      source: "note",
      id: n.id,
      title: n.title,
      date: n.date,
      text: "",
      full,
      grams: countGrams(`${n.title}\n${full}`),
    });
  }
  const df = new Map<string, number>();
  for (const doc of docs) for (const g of doc.grams.keys()) df.set(g, (df.get(g) ?? 0) + 1);
  return { docs, df };
}

/** 取匹配最密集的一段作为摘录，而不是一律截开头 */
function excerpt(full: string, queryGrams: Set<string>): string {
  if (full.length <= SNIPPET_CHARS) return full;
  const step = Math.floor(SNIPPET_CHARS / 2);
  let best = 0;
  let bestScore = -1;
  for (let start = 0; start < full.length; start += step) {
    const win = full.slice(start, start + SNIPPET_CHARS);
    let score = 0;
    for (const g of countGrams(win).keys()) if (queryGrams.has(g)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  const body = full.slice(best, best + SNIPPET_CHARS);
  return `${best > 0 ? "…" : ""}${body}${best + SNIPPET_CHARS < full.length ? "…" : ""}`;
}

export function retrieveSnippets(
  query: string,
  diaries: Diary[],
  notes: PersonaNote[],
  limit = 4,
): Snippet[] {
  // 签名覆盖每篇的 id 与正文长度：增删、转私密、改正文都会让索引重建
  const sig = [...diaries.map((d) => `${d.id}:${d.summary?.length ?? 0}`), `n${notes.length}:${notes[0]?.id ?? ""}`].join("|");
  if (!cached || cached.sig !== sig || Date.now() - cached.at > INDEX_TTL_MS) {
    cached = { at: Date.now(), sig, ...buildIndex(diaries, notes) };
  }
  const { docs, df } = cached;
  if (docs.length === 0) return [];

  const q = countGrams(query);
  if (q.size === 0) return [];
  const n = docs.length;
  // 超过四分之一文章都出现的词片（「什么」「为什」「自己」）不算命中，否则问句的虚词会把无关文章带进来
  const terms = [...q.keys()].filter((g) => (df.get(g) ?? 0) <= Math.max(2, n * 0.25));
  if (terms.length === 0) return [];
  // 只命中一个词片的文档多半是巧合（「你好」「测试」），不值得占上下文
  const minHits = Math.min(2, terms.length);
  const scored: { doc: Doc; score: number }[] = [];
  for (const doc of docs) {
    let score = 0;
    let hits = 0;
    for (const g of terms) {
      const tf = doc.grams.get(g);
      if (!tf) continue;
      hits++;
      const idf = Math.log(1 + n / (df.get(g) ?? 1));
      score += idf * (1 + Math.log(tf));
    }
    // 长文天然命中多，按长度做温和归一
    if (hits >= minHits) scored.push({ doc, score: score / Math.log(10 + doc.grams.size) });
  }
  scored.sort((a, b) => b.score - a.score);

  const qSet = new Set(q.keys());
  return scored.slice(0, limit).map(({ doc }) => ({
    source: doc.source,
    id: doc.id,
    title: doc.title,
    date: doc.date,
    href: doc.href,
    text: excerpt(doc.full, qSet),
  }));
}
