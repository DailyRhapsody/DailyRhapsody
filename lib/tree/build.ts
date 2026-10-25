import { getCachedDiaries } from "@/lib/notion";
import {
  acquireBuildLock,
  clearTreeStale,
  getTaxonomy,
  getTree,
  releaseBuildLock,
  saveTaxonomy,
  saveTree,
  type Classification,
  type Taxonomy,
  type TreeData,
  type TreeFamily,
  type TreeTopic,
} from "./store";

/**
 * 思维大树重建：增量分类 + 全量组装。
 *
 * 增量规则：旧树里已归过类的文章直接复用路径，只把新文章送模型。这样单次重建
 * 通常只有一批模型调用，能放进 Vercel 函数 300s 预算；老叶的分类也不会因为模型
 * 重新判断而左右漂移。细类仍可随新文章演化——模型可以在已有中类下提出新的细类。
 *
 * 单次最多跑 MAX_BATCHES 批；没分完就保留 stale 标记，下一次读请求继续追平。
 */

const BATCH_SIZE = 28;
const DEFAULT_MAX_BATCHES = 3;
const MIN_SUMMARY_LEN = 8;
const MODEL_TIMEOUT_MS = 90_000;

type RebuildStatus = "built" | "partial" | "locked" | "no-data" | "no-entries";

export type RebuildResult = {
  status: RebuildStatus;
  entries?: number;
  classified?: number;
  pending?: number;
  families?: number;
};

type Entry = { id: string; date: string; summary: string; name?: string };

function llmConfig() {
  return {
    base: (process.env.PERSONA_LLM_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, ""),
    key: process.env.PERSONA_LLM_API_KEY?.trim() || "",
    model: process.env.PERSONA_LLM_MODEL?.trim() || "deepseek-chat",
  };
}

async function callModel(prompt: string, maxTokens: number): Promise<string> {
  const { base, key, model } = llmConfig();
  if (!key) throw new Error("PERSONA_LLM_API_KEY 未配置");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`模型请求失败 ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型返回为空");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型没有返回 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function classifyBatch(
  taxonomy: Taxonomy,
  batch: Entry[]
): Promise<(Classification & { id: string })[]> {
  const prompt = `下面是已经确定的思维大树分类体系和一批公开日记摘要。请为每条日记选择唯一的一条 family > topic > sub 路径。

分类体系：
${JSON.stringify(taxonomy)}

规则：
1. 必须使用分类体系中已有的家族与中类名称；细类优先使用已有名称，确实不合适时可以在该中类下新建 2–6 个汉字的细类。
2. 每条日记只归入一条路径，按内容主旨判断，不按标签、日期或字数。
3. 只输出 JSON：{"assignments":[{"id":"...","family":"...","topic":"...","sub":"..."}]}
4. 必须覆盖输入中的全部 id，不得遗漏。

日记：
${batch.map((entry) => `${entry.id}｜${entry.date}｜${entry.summary.slice(0, 650)}`).join("\n")}`;
  const text = await callModel(prompt, 4096);
  const parsed = parseJson(text) as { assignments?: unknown };
  return Array.isArray(parsed.assignments)
    ? (parsed.assignments as (Classification & { id: string })[])
    : [];
}

/** 归类结果必须落在已有家族/中类上；新细类就地追加进 taxonomy。 */
function validPath(taxonomy: Taxonomy, item: Classification & { id: string }): Classification | null {
  const family = taxonomy.families.find((f) => f.name === item.family);
  if (!family) return null;
  const topic = family.topics.find((t) => t.name === item.topic);
  if (!topic) return null;
  let sub = String(item.sub || "").trim();
  if (!sub) sub = topic.subs[0];
  if (!topic.subs.includes(sub)) topic.subs.push(sub);
  return { family: family.name, topic: topic.name, sub };
}

/** 旧树里的 id → 分类路径，增量重建的「已分类」依据。 */
function existingAssignments(tree: TreeData): Map<string, Classification> {
  const map = new Map<string, Classification>();
  for (const family of tree.families ?? []) {
    for (const topic of family.topics ?? []) {
      for (const entry of topic.entries ?? []) {
        map.set(String(entry.id), { family: family.name, topic: topic.name, sub: entry.sub });
      }
    }
  }
  return map;
}

function dateParts(date: string): { year: number; month: number; day: number } | null {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

function buildTree(
  taxonomy: Taxonomy,
  entries: Entry[],
  shortIds: Set<string>,
  assignments: Map<string, Classification>
): TreeData {
  type Dated = { entry: Entry; path: Classification; parts: { year: number; month: number; day: number } };
  const dated: Dated[] = [];
  for (const entry of entries) {
    const path = assignments.get(entry.id) ?? (shortIds.has(entry.id) ? { family: "短记", topic: "无正文", sub: "短记" } : null);
    if (!path) continue;
    const parts = dateParts(entry.date);
    if (parts) dated.push({ entry, path, parts });
  }
  dated.sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.entry.id.localeCompare(b.entry.id));

  const epoch = { year: 2021, month: 3 };
  if (dated.length) {
    const first = dateParts(new Date(`${dated[0].entry.date}T00:00:00Z`).toISOString().slice(0, 10))!;
    epoch.year = first.year;
    epoch.month = first.month;
  }
  const epochMonth = epoch.year * 12 + epoch.month;

  const byFamily = new Map<string, Map<string, Map<string, { id: string; date: string; t: number; sub: string }[]>>>();
  for (const item of dated) {
    const { family, topic, sub } = item.path;
    if (!byFamily.has(family)) byFamily.set(family, new Map());
    const topics = byFamily.get(family)!;
    if (!topics.has(topic)) topics.set(topic, new Map());
    const subs = topics.get(topic)!;
    if (!subs.has(sub)) subs.set(sub, []);
    subs.get(sub)!.push({
      id: item.entry.id,
      date: item.entry.date,
      t: (item.parts.year - epoch.year) * 12 + (item.parts.month - epoch.month) + (item.parts.day - 1) / 31,
      sub,
      ...(item.entry.name ? { name: item.entry.name } : {}),
    });
  }

  const families: TreeFamily[] = taxonomy.families
    .map((family) => {
      const topics = byFamily.get(family.name);
      if (!topics) return null;
      const built: TreeTopic[] = [...topics.entries()]
        .map(([topicName, subs]) => ({
          id: `${family.name}-${topicName}`,
          name: topicName,
          subs: [...subs.entries()]
            .map(([name, list]) => ({ name, count: list.length }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
          entries: [...subs.values()].flat().sort((a, b) => a.t - b.t || a.id.localeCompare(b.id)),
        }))
        .sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name));
      return { id: family.name, name: family.name, topics: built };
    })
    .filter((family): family is TreeFamily => Boolean(family));

  const shortDated = dated.filter((item) => item.path.family === "短记");
  if (shortDated.length) {
    families.push({
      id: "短记",
      name: "短记",
      topics: [
        {
          id: "短记-无正文",
          name: "无正文",
          subs: [{ name: "短记", count: shortDated.length }],
          entries: shortDated.map((item) => ({
            id: item.entry.id,
            date: item.entry.date,
            t: (item.parts.year - epoch.year) * 12 + (item.parts.month - epoch.month) + (item.parts.day - 1) / 31,
            sub: "短记",
            ...(item.entry.name ? { name: item.entry.name } : {}),
          })),
        },
      ],
    });
  }

  return {
    schema: "dr.tree/1",
    generatedAt: new Date().toISOString(),
    epochMonth,
    lastDate: dated.length ? dated[dated.length - 1].entry.date : "",
    source: { entries: entries.length, public: entries.length },
    families,
  };
}

/**
 * 在后台跑一轮重建。调用方（/api/tree）用 waitUntil 触发，本次请求仍返回旧树。
 * 失败一律抛错，由调用方记录；树不写、标记不清，下一轮重试。
 */
export async function rebuildTree(opts?: { maxBatches?: number }): Promise<RebuildResult> {
  const maxBatches = opts?.maxBatches ?? DEFAULT_MAX_BATCHES;
  if (!(await acquireBuildLock())) return { status: "locked" };
  try {
    const diaries = await getCachedDiaries();
    if (!diaries) return { status: "no-data" };
    const entries: Entry[] = diaries
      .filter((entry) => entry.isPublic !== false)
      .map((entry) => ({
        id: String(entry.id),
        date: String(entry.date || entry.publishedAt || "").slice(0, 10),
        summary: String(entry.summary || "").replace(/\s+/g, " ").trim(),
        name: String(entry.name || "").trim() || undefined,
      }))
      .filter((entry) => entry.id && entry.date);
    if (!entries.length) return { status: "no-entries" };

    const shortIds = new Set(entries.filter((e) => e.summary.length < MIN_SUMMARY_LEN).map((e) => e.id));
    const textEntries = entries.filter((e) => e.summary.length >= MIN_SUMMARY_LEN);

    const taxonomy = await getTaxonomy();
    const assignments = existingAssignments(await getTree());
    const missing = textEntries.filter((entry) => !assignments.has(entry.id));

    const batches: Entry[][] = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) batches.push(missing.slice(i, i + BATCH_SIZE));
    const runBatches = batches.slice(0, maxBatches);

    for (const batch of runBatches) {
      let pending = batch;
      for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
        const result = await classifyBatch(taxonomy, pending);
        for (const item of result) {
          if (!item?.id) continue;
          const id = String(item.id);
          if (!pending.some((entry) => entry.id === id)) continue;
          const path = validPath(taxonomy, item);
          if (path) assignments.set(id, path);
        }
        pending = batch.filter((entry) => !assignments.has(entry.id));
      }
      if (pending.length) {
        // 这一批有漏项：保留给下一轮，不拿半成品覆盖整棵树。
        throw new Error(`分类残留 ${pending.length} 条`);
      }
    }

    const tree = buildTree(taxonomy, entries, shortIds, assignments);
    const classified = entries.filter((entry) => assignments.has(entry.id) || shortIds.has(entry.id)).length;
    if (classified < textEntries.length * 0.5) {
      throw new Error(`分类覆盖率过低：${classified}/${textEntries.length}`);
    }
    await saveTree(tree);
    await saveTaxonomy(taxonomy);
    const remaining = missing.length - runBatches.reduce((sum, batch) => sum + batch.length, 0);
    if (remaining <= 0) await clearTreeStale();

    return {
      status: remaining > 0 ? "partial" : "built",
      entries: entries.length,
      classified,
      pending: Math.max(0, remaining),
      families: tree.families.length,
    };
  } finally {
    await releaseBuildLock();
  }
}
