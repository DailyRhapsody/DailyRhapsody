// 把 Reference 的中文摘要与公司档案字段预翻译成英文，写入 Redis 哈希
// dr:reference:en:v1（field=item id, value=JSON）。
//
// 只翻译「解释性字段」：摘要、公司档案里的场景/产品/文化/市场/标签/销售/盈亏/上市口径。
// 公司名、产品名、人名保持原样；标题用 Notion 里的 Name 字段，不翻译。
//
// 用法：node scripts/translate-reference-en.mjs [--limit 20] [--force]

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
  const idx = trimmed.indexOf("=");
  env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
}

const KV_URL = env.KV_REST_API_URL;
const KV_TOKEN = env.KV_REST_API_TOKEN;
const LLM_URL = env.PERSONA_LLM_BASE_URL;
const LLM_KEY = env.PERSONA_LLM_API_KEY;
const LLM_MODEL = env.PERSONA_LLM_MODEL || "deepseek-chat";
const HASH = "dr:reference:en:v1";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

async function kv(pathname, init = {}) {
  const res = await fetch(`${KV_URL}/${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${KV_TOKEN}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  return res.json();
}

async function readItems() {
  const raw = await kv("get/notion:reference:items:v2");
  const parsed = typeof raw.result === "string" ? JSON.parse(raw.result) : raw.result;
  return parsed.data ?? parsed;
}

async function readExisting() {
  const raw = await kv(`hgetall/${HASH}`);
  const flat = raw.result ?? [];
  const map = new Map();
  for (let i = 0; i < flat.length; i += 2) map.set(flat[i], flat[i + 1]);
  return map;
}

const COMPANY_FIELDS = [
  "operationCulture",
  "productForms",
  "markets",
  "scenarios",
  "companyTags",
  "interviewStatus",
  "salesModes",
  "profitability",
  "listed",
];

function payloadFor(item) {
  const payload = {};
  if (item.summary) payload.summary = item.summary;
  if (item.company) {
    const company = {};
    for (const field of COMPANY_FIELDS) {
      const value = item.company[field];
      if (Array.isArray(value) ? value.length > 0 : Boolean(value)) company[field] = value;
    }
    if (Object.keys(company).length > 0) payload.company = company;
  }
  return payload;
}

function stripFence(text) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

async function translateBatch(entries) {
  const body = {
    model: LLM_MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You translate Chinese industry-research metadata into concise professional English. " +
          "Keep company names, product names and people names unchanged. Keep arrays as arrays. " +
          "Return ONLY a JSON object keyed by the input ids, with the same shape as the input.",
      },
      {
        role: "user",
        content: JSON.stringify(Object.fromEntries(entries)),
      },
    ],
  };
  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LLM_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = stripFence(data.choices?.[0]?.message?.content ?? "");
  return JSON.parse(text);
}

async function hset(id, value) {
  await kv(`hset/${HASH}/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

async function main() {
  if (!KV_URL || !LLM_KEY) throw new Error("缺少 KV 或模型配置");
  const items = await readItems();
  const existing = FORCE ? new Map() : await readExisting();
  const pending = items
    .filter((item) => payloadFor(item) && Object.keys(payloadFor(item)).length > 0)
    .filter((item) => !existing.has(item.id))
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`待翻译 ${pending.length} 条，已缓存 ${existing.size} 条`);
  if (pending.length === 0) return;

  const BATCH = 6;
  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const entries = batch.map((item) => [item.id, payloadFor(item)]);
    try {
      const result = await translateBatch(entries);
      for (const [id] of entries) {
        if (result[id]) await hset(id, result[id]);
      }
      done += batch.length;
      console.log(`  ${done}/${pending.length}`);
    } catch (err) {
      console.error(`  批次失败（${i}）：${err.message}`);
    }
  }
  const after = await readExisting();
  console.log(`完成：哈希内 ${after.size} 条`);
}

main().catch((err) => {
  console.error("失败：", err.message);
  process.exit(1);
});
