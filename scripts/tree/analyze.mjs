#!/usr/bin/env node
/**
 * 用模型分析公开日记摘要，生成思维大树数据。
 *
 * 输入：{id,date,publishedAt,summary}[]，只应包含公开文章。
 * 输出：public/tree/tree.json，只含标签、ID、日期与计数，不含正文。
 *
 * 这里不使用 tags 字段；家族、中类、细类全部由模型阅读摘要后提出并归类。
 * 模型调用走 PERSONA_LLM_* 环境变量，密钥不落盘。
 */
import fs from "node:fs";
import path from "node:path";
import { redactPII } from "./redact.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const inputPath = process.argv.find((arg) => arg.startsWith("--input="))?.slice(8)
  || path.join(repo, "data/tree-entries.json");
const outputPath = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9)
  || path.join(repo, "public/tree/tree.json");

function loadEnv() {
  const env = { ...process.env };
  const file = path.join(repo, ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = loadEnv();
const model = env.PERSONA_LLM_MODEL || "deepseek-chat";
const base = (env.PERSONA_LLM_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const apiKey = env.PERSONA_LLM_API_KEY;
if (!apiKey) throw new Error("PERSONA_LLM_API_KEY 未配置");

const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const entries = (Array.isArray(raw) ? raw : raw.data || raw.results || [])
  .filter((entry) => entry.isPublic !== false)
  .map((entry) => ({
    id: String(entry.id),
    date: String(entry.date || entry.publishedAt || "").slice(0, 10),
    summary: redactPII(String(entry.summary || "").replace(/\s+/g, " ").trim()).slice(0, 700),
    name: String(entry.name || "").trim() || undefined,
  }))
  .filter((entry) => entry.id && entry.date);
const textEntries = entries.filter((entry) => entry.summary.length >= 8);
const shortEntries = entries.filter((entry) => entry.summary.length < 8);

if (textEntries.length < 20) throw new Error(`公开正文条目太少：${textEntries.length}`);

async function callModel(messages, maxTokens = 4096) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`模型请求失败 ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型返回为空");
  return content;
}

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型没有返回 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function sampleForTaxonomy(list, count) {
  const step = Math.max(1, Math.floor(list.length / count));
  const sample = [];
  for (let i = 0; i < list.length && sample.length < count; i += step) sample.push(list[i]);
  return sample.map((entry) => `${entry.id}｜${entry.date}｜${entry.summary.slice(0, 320)}`).join("\n");
}

async function buildTaxonomy() {
  const sample = sampleForTaxonomy(textEntries, 42);
  const prompt = `你在为一个人的公开日记建立“思维大树”的语义结构。请阅读下面的日记摘要，提出 9 个家族、每个家族 2–4 个中类、每个中类 1–3 个细类。

要求：
1. 家族、中类、细类都必须从内容中归纳，名称使用 2–6 个汉字。
2. 家族是最高层主题；中类是家族内的稳定子主题；细类是更具体的语义簇。
3. 不要使用标签字段，不要按年份或月份分组，不要输出“其他”作为主要家族。
4. 同一层名称不得重复；三类名称都要能独立读懂。
5. 只输出 JSON，结构为：
{"families":[{"name":"...","topics":[{"name":"...","subs":["...","..."]}]}]}

日记摘要（id｜日期｜摘要）：
${sample}`;
  let taxonomy;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await callModel([{ role: "user", content: prompt }], 6000);
      taxonomy = parseJson(text);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  const families = (taxonomy?.families || []).filter((family) =>
    family?.name && Array.isArray(family.topics)
  );
  if (families.length < 7 || families.length > 12) {
    throw new Error(`家族数量异常：${families.length}`);
  }
  for (const family of families) {
    family.topics = family.topics.filter((topic) => topic?.name && Array.isArray(topic.subs));
    if (!family.topics.length) throw new Error(`家族 ${family.name} 没有中类`);
    for (const topic of family.topics) {
      topic.subs = [...new Set(topic.subs.filter((sub) => typeof sub === "string" && sub.trim()))];
      if (!topic.subs.length) topic.subs = ["短记"];
    }
  }
  return { families };
}

async function classifyBatch(taxonomy, batch) {
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
  const text = await callModel([{ role: "user", content: prompt }], 4096);
  const parsed = parseJson(text);
  return Array.isArray(parsed.assignments) ? parsed.assignments : [];
}

function validPath(taxonomy, assignment) {
  const family = taxonomy.families.find((item) => item.name === assignment.family);
  if (!family) return null;
  const topic = family.topics.find((item) => item.name === assignment.topic);
  if (!topic) return null;
  let sub = String(assignment.sub || "").trim();
  if (!sub) sub = topic.subs[0];
  if (!topic.subs.includes(sub)) topic.subs.push(sub);
  return { family: family.name, topic: topic.name, sub };
}

async function classifyAll(taxonomy) {
  const assignments = new Map();
  const batches = [];
  for (let i = 0; i < textEntries.length; i += 28) batches.push(textEntries.slice(i, i + 28));
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let missing = batch;
    for (let attempt = 0; attempt < 2 && missing.length; attempt++) {
      const result = await classifyBatch(taxonomy, missing);
      for (const item of result) {
        const path = validPath(taxonomy, item);
        if (path && missing.some((entry) => entry.id === String(item.id))) {
          assignments.set(String(item.id), path);
        }
      }
      missing = batch.filter((entry) => !assignments.has(entry.id));
      if (missing.length) process.stderr.write(`批次 ${i + 1} 缺少 ${missing.length} 条，重试\n`);
    }
    process.stderr.write(`分类批次 ${i + 1}/${batches.length} 完成，累计 ${assignments.size}/${textEntries.length}\n`);
  }
  return assignments;
}

function buildTree(taxonomy, assignments) {
  const dated = entries
    .map((entry) => ({ entry, path: assignments.get(entry.id) || (shortEntries.some((item) => item.id === entry.id)
      ? { family: "短记", topic: "无正文", sub: "短记" }
      : null) }))
    .filter((item) => item.path)
    .map((item) => ({ ...item, parts: dateParts(item.entry.date) }))
    .filter((item) => item.parts)
    .sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.entry.id.localeCompare(b.entry.id));
  if (dated.length < textEntries.length * 0.9) {
    throw new Error(`分类覆盖率不足：${dated.length}/${textEntries.length}`);
  }
  const epoch = dated.length ? { year: dated[0].parts.year, month: dated[0].parts.month } : { year: 2021, month: 3 };
  const epochMonth = epoch.year * 12 + epoch.month;
  const byFamily = new Map();
  for (const item of dated) {
    const { family, topic, sub } = item.path;
    if (!byFamily.has(family)) byFamily.set(family, new Map());
    const topics = byFamily.get(family);
    if (!topics.has(topic)) topics.set(topic, new Map());
    const subs = topics.get(topic);
    if (!subs.has(sub)) subs.set(sub, []);
    subs.get(sub).push({
      id: item.entry.id,
      date: item.entry.date,
      t: (item.parts.year - epoch.year) * 12 + (item.parts.month - epoch.month) + (item.parts.day - 1) / 31,
      sub,
      ...(item.entry.name ? { name: item.entry.name } : {}),
    });
  }
  const families = taxonomy.families.map((family) => {
    const topics = byFamily.get(family.name);
    if (!topics) return null;
    return {
      id: family.name,
      name: family.name,
      topics: [...topics.entries()].map(([topicName, subs]) => ({
        id: `${family.name}-${topicName}`,
        name: topicName,
        subs: [...subs.entries()]
          .map(([name, list]) => ({ name, count: list.length }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        entries: [...subs.values()].flat().sort((a, b) => a.t - b.t || a.id.localeCompare(b.id)),
      })).sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name)),
    };
  }).filter(Boolean);
  if (shortEntries.length) {
    const shortDated = dated.filter((item) => item.path.family === "短记");
    if (shortDated.length) {
      families.push({
        id: "短记",
        name: "短记",
        topics: [{
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
        }],
      });
    }
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

function dateParts(date) {
  const d = new Date(date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

async function main() {
  process.stderr.write(`读取 ${entries.length} 条公开日记\n`);
  const taxonomyPath = path.join(repo, "public/tree/taxonomy.json");
  let taxonomy;
  if (fs.existsSync(taxonomyPath)) {
    taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, "utf8"));
    process.stderr.write("复用已冻结的分类体系\n");
  } else {
    taxonomy = await buildTaxonomy();
    fs.writeFileSync(taxonomyPath, JSON.stringify(taxonomy, null, 2));
  }
  process.stderr.write(`分类体系：${taxonomy.families.length} 个家族\n`);
  const assignments = await classifyAll(taxonomy);
  const tree = buildTree(taxonomy, assignments);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(tree));
  const report = {
    generatedAt: tree.generatedAt,
    entries: entries.length,
    analyzed: textEntries.length,
    short: shortEntries.length,
    assigned: assignments.size,
    families: tree.families.length,
    topics: tree.families.reduce((sum, family) => sum + family.topics.length, 0),
    lastDate: tree.lastDate,
  };
  fs.writeFileSync(path.join(repo, "public/tree/report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
