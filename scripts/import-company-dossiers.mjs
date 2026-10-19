// 把 cache/scratch/research/companies/*.md 的公司档案写进 Notion Reference 库：
//  - 每家公司先建一个 Type=行业档案 的页面（属性来自 dossier 的关键事实）
//  - 再把正文按 markdown 转成 Notion blocks 追加到页面里
//
// 用法：
//   node scripts/import-company-dossiers.mjs --dry-run   # 只解析，不写 Notion
//   node scripts/import-company-dossiers.mjs             # 真正写入
//
// 幂等：按 Name 查库，已存在就跳过（不覆盖已有内容）。

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOSSIER_DIR =
  process.env.DOSSIER_DIR ||
  path.join(process.env.HOME, ".hermes/profiles/dailyrhapsody/cache/scratch/research/companies");
const DRY = process.argv.includes("--dry-run");

function loadEnv() {
  const env = {};
  const file = path.join(ROOT, ".env.local");
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const NOTION_TOKEN = env.NOTION_TOKEN;
const DB_ID = env.NOTION_REFERENCE_DB_ID;
const NOTION_VERSION = "2022-06-28";

async function notion(pathname, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

const rich = (content) => [{ type: "text", text: { content: content.slice(0, 1900) } }];

function stripInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    .trim();
}

/** 把 markdown 转成 Notion blocks；表格按行转成 bulleted_list_item。 */
function markdownToBlocks(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let tableRows = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = stripInline(paragraph.join(" "));
    paragraph = [];
    if (!text) return;
    // Notion 单个 rich_text 上限 2000 字符，长段落拆成多个 paragraph
    for (let i = 0; i < text.length; i += 1900) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: rich(text.slice(i, i + 1900)) },
      });
    }
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const rows = tableRows;
    tableRows = [];
    for (const row of rows) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length === 0) continue;
      const text = stripInline(cells.join(" · "));
      if (!text) continue;
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: rich(text) },
      });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushTable();
      continue;
    }
    if (trimmed.startsWith("|")) {
      flushParagraph();
      if (!/^\|[\s:|-]+\|$/.test(trimmed)) tableRows.push(trimmed);
      continue;
    }
    flushTable();

    if (trimmed.startsWith("# ")) {
      flushParagraph();
      // 跳过一级标题：页面标题已经承担这一层
      continue;
    }
    if (trimmed.startsWith("### ")) {
      flushParagraph();
      blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: rich(stripInline(trimmed.slice(4))) } });
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushParagraph();
      blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: rich(stripInline(trimmed.slice(3))) } });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      const indent = line.match(/^\s*/)[0].length;
      const text = stripInline(trimmed.replace(/^[-*]\s+/, ""));
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: rich(`${indent >= 2 ? "– " : ""}${text}`) },
      });
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: rich(stripInline(trimmed.replace(/^\d+\.\s+/, ""))) },
      });
      continue;
    }
    if (trimmed.startsWith("> ")) {
      flushParagraph();
      blocks.push({ object: "block", type: "quote", quote: { rich_text: rich(stripInline(trimmed.slice(2))) } });
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushTable();
  return blocks;
}

function oneLiner(markdown) {
  const match = markdown.match(/## 1 一句话定位\s*\n+([^\n#]+)/);
  return match ? stripInline(match[1]).slice(0, 180) : "";
}

const COMPANIES = [
  {
    file: "qidaisong.md",
    name: "Qidaisong Technology",
    titleZh: "奇岱松科技",
    url: "https://www.pinefield.cn/",
    year: 2019,
    summary: "以「物理空间即计算设备」为命题的基础软件公司，自研空间计算操作系统并向园区、医院等场景交付感知、建模、调度一体化方案。",
    properties: {
      "公司名称": { rich_text: rich("奇岱松科技") },
      "公司标签": { multi_select: [{ name: "初创公司" }] },
      Domain: { multi_select: [{ name: "调度与集群" }] },
      "运营文化": { select: { name: "软件基因" } },
      "是否上市": { select: { name: "否" } },
      "售卖形态": { multi_select: [{ name: "软硬一体" }, { name: "SaaS" }] },
    },
  },
  {
    file: "tuya.md",
    name: "Tuya Smart",
    titleZh: "涂鸦智能",
    url: "https://www.tuya.com",
    year: 2014,
    summary: "全球领先的独立 IoT PaaS 平台，向品牌与代工厂出售「模组＋云＋App」交钥匙方案，使非技术企业能在数月内推出联网设备。",
    properties: {
      "公司名称": { rich_text: rich("涂鸦智能 Tuya Inc.") },
      "公司标签": { multi_select: [{ name: "互联网" }] },
      "业务人数": { number: 1441 },
      "是否上市": { select: { name: "是" } },
      "业务盈亏": { select: { name: "小幅盈利" } },
      "运营文化": { select: { name: "软件基因" } },
      "售卖形态": { multi_select: [{ name: "SaaS" }, { name: "软硬一体" }] },
    },
  },
  {
    file: "hai-robotics.md",
    name: "Hai Robotics",
    titleZh: "海柔创新",
    url: "https://www.hairobotics.cn/",
    year: 2016,
    summary: "全球最大的箱式仓储机器人（ACR）厂商，让机器人直接从货架取出货箱送到工作站，把仓库作业从「人找货」改为「货箱到人」。",
    properties: {
      "公司名称": { rich_text: rich("海柔创新 Hai Robotics") },
      "公司标签": { multi_select: [{ name: "独角兽" }] },
      "业务人数": { number: 1447 },
      "RobotType": { multi_select: [{ name: "仓储物流" }] },
      "产品形态": { multi_select: [{ name: "料箱机器人" }, { name: "攀爬机器人" }] },
      "场景定位": { multi_select: [{ name: "仓储" }] },
      "是否上市": { select: { name: "否" } },
      "业务盈亏": { select: { name: "持续亏损" } },
      "运营文化": { select: { name: "硬件生产" } },
      "售卖形态": { multi_select: [{ name: "软硬一体" }, { name: "集成方案" }] },
    },
  },
  {
    file: "x-square-robot.md",
    name: "X Square Robot",
    titleZh: "自变量机器人",
    url: "https://x2robot.com",
    year: 2023,
    summary: "以端到端「世界统一模型」为技术内核的通用具身智能公司，自研模型、本体与数采设备，主攻家庭服务与物流分拣。",
    properties: {
      "公司名称": { rich_text: rich("自变量机器人 X Square Robot") },
      "公司标签": { multi_select: [{ name: "初创公司" }] },
      Domain: { multi_select: [{ name: "具身智能（VLA）" }] },
      RobotType: { multi_select: [{ name: "服务机器人" }] },
      "产品形态": { multi_select: [{ name: "轮式双臂机器人" }, { name: "机械臂灵巧手" }] },
      "场景定位": { multi_select: [{ name: "清洁" }, { name: "分拣包装" }] },
      "是否上市": { select: { name: "否" } },
      "运营文化": { select: { name: "软件基因" } },
      "售卖形态": { multi_select: [{ name: "软硬一体" }] },
    },
  },
  {
    file: "agibot.md",
    name: "AgiBot",
    titleZh: "智元机器人",
    url: "https://www.agibot.com.cn",
    year: 2023,
    summary: "以「三智一体」全栈产品矩阵与万台级量产为核心的通用具身机器人平台公司，2025 年人形出货量居全球第一。",
    properties: {
      "公司名称": { rich_text: rich("智元机器人 AgiBot") },
      "公司标签": { multi_select: [{ name: "独角兽" }] },
      "业务人数": { number: 1570 },
      Domain: { multi_select: [{ name: "具身智能（VLA）" }] },
      RobotType: { multi_select: [{ name: "人形机器人" }] },
      "产品形态": { multi_select: [{ name: "足式人形机器人" }, { name: "轮式双臂机器人" }] },
      "场景定位": { multi_select: [{ name: "制造" }] },
      "是否上市": { select: { name: "否" } },
      "运营文化": { select: { name: "硬件生产" } },
      "售卖形态": { multi_select: [{ name: "软硬一体" }, { name: "集成方案" }] },
    },
  },
];

async function findExisting(name) {
  const body = {
    filter: { property: "Name", title: { equals: name } },
    page_size: 1,
  };
  const res = await notion(`/databases/${DB_ID}/query`, { method: "POST", body: JSON.stringify(body) });
  return res.results?.[0] ?? null;
}

async function createPage(company, markdown) {
  const today = new Date().toISOString().slice(0, 10);
  const properties = {
    Name: { title: [{ type: "text", text: { content: company.name } }] },
    TitleZh: { rich_text: rich(company.titleZh) },
    Type: { select: { name: "行业档案" } },
    Summary: { rich_text: rich(company.summary || oneLiner(markdown)) },
    URL: { url: company.url },
    Year: { number: company.year },
    Source: { select: { name: "手动添加" } },
    License: { select: { name: "自有" } },
    Copyright: { rich_text: rich("DailyRhapsody") },
    Public: { checkbox: true },
    CollectedAt: { date: { start: today } },
    ...company.properties,
  };
  return notion("/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: DB_ID }, properties }),
  });
}

async function appendBlocks(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 90) {
    const chunk = blocks.slice(i, i + 90);
    await notion(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: chunk }),
    });
    process.stdout.write(`  追加 ${Math.min(i + 90, blocks.length)}/${blocks.length} 块\n`);
  }
}

async function main() {
  if (!NOTION_TOKEN || !DB_ID) throw new Error("缺少 NOTION_TOKEN 或 NOTION_REFERENCE_DB_ID");
  for (const company of COMPANIES) {
    const file = path.join(DOSSIER_DIR, company.file);
    const markdown = fs.readFileSync(file, "utf8");
    const blocks = markdownToBlocks(markdown);
    const chars = markdown.replace(/\s/g, "").length;
    console.log(`\n== ${company.titleZh} (${company.name})  ${chars} 字  ${blocks.length} 块`);
    if (DRY) {
      console.log("  dry-run：不写 Notion");
      continue;
    }
    const existing = await findExisting(company.name);
    if (existing) {
      console.log(`  已存在，跳过：${existing.id}`);
      continue;
    }
    const page = await createPage(company, markdown);
    console.log(`  已建页面：${page.id}`);
    await appendBlocks(page.id, blocks);
  }
}

main().catch((err) => {
  console.error("失败：", err.message);
  process.exit(1);
});
