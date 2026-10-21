#!/usr/bin/env node
/**
 * 从站点现有的 Notion/Redis 缓存取公开日记的 id、日期与摘要。
 * 只读取公开条目；输出 data/tree-entries.json 供 analyze.mjs 使用。
 * 不打印正文，不把 Redis 凭据写入文件。
 */
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const envFile = path.join(repo, ".env.local");
const env = { ...process.env };
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
const url = env.KV_REST_API_URL;
const token = env.KV_REST_API_READ_ONLY_TOKEN || env.KV_REST_API_TOKEN;
if (!url || !token) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN 未配置");

// 缓存键不写死版本号：先读 latest 别名，再按版本号探测。
// 上游升版（v5→v6→v7）时这里不需要跟着改；2026-10 就是因为写死 v6 断了采集。
const ALIAS_KEY = "notion:diaries:latest";
const PROBE_KEYS = Array.from({ length: 12 }, (_, i) => `notion:diaries:v${12 - i}`);

async function readKey(key) {
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const payload = await res.json();
  let value = payload.result;
  if (typeof value === "string") value = JSON.parse(value);
  const list = Array.isArray(value) ? value : value?.data || value?.results || [];
  return Array.isArray(list) && list.length ? list : null;
}

let all = null;
let usedKey = null;
for (const key of [ALIAS_KEY, ...PROBE_KEYS]) {
  all = await readKey(key);
  if (all) {
    usedKey = key;
    break;
  }
}
if (!all) throw new Error("博客缓存全空：latest 别名与 v1–v12 均无数据");
console.error(`[tree] 使用缓存键 ${usedKey}`);

const publicEntries = all
  .filter((entry) => entry.isPublic !== false)
  .map((entry) => ({
    id: String(entry.id),
    date: String(entry.date || entry.publishedAt || "").slice(0, 10),
    summary: String(entry.summary || "").replace(/\s+/g, " ").trim(),
  }))
  .filter((entry) => entry.id && entry.date);

const output = path.join(repo, "data/tree-entries.json");
fs.writeFileSync(output, JSON.stringify(publicEntries, null, 2));
console.log(JSON.stringify({ output, entries: publicEntries.length, short: publicEntries.filter((entry) => entry.summary.length < 8).length }));
