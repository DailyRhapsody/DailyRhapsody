// 把深调档案追加到 Notion Reference 里「已存在的公司/产品页面」，
// 不新建重复条目；已有同主题深度正文的页面自动跳过。
//
// 用法：
//   node scripts/append-company-dossiers.mjs --dry-run
//   node scripts/append-company-dossiers.mjs --dir=/path/to/dossiers
//   node scripts/append-company-dossiers.mjs --dir=... --update-summary

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry-run");
const UPDATE_SUMMARY = process.argv.includes("--update-summary");
const dirArg = process.argv.find((arg) => arg.startsWith("--dir="));
const DOSSIER_DIR =
  dirArg?.slice("--dir=".length) ||
  process.env.DOSSIER_DIR ||
  path.join(process.env.HOME, ".hermes/cache/scratch/company-dossiers");

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
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
        .map((cell) => cell.trim())
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

  for (const line of lines) {
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
      continue; // 页面标题已有公司名
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
      const text = stripInline(trimmed.replace(/^[-*]\s+/, ""));
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: rich(text) },
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

function plain(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

const FILE_ALIASES = {
  "amazon-astro": ["Amazon Astro", "亚马逊 Astro"],
  "cobalt-robotics": ["Cobalt Robotics", "Cobalt AI"],
  "sony-aibo": ["Sony Aibo", "索尼 Aibo", "aibo"],
  savioke: ["Savioke"],
};

function dossierNameOf(file, markdown) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1] || file.replace(/\.md$/, "");
  return heading
    .replace(/公司档案|公司调研|档案/g, "")
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/[·|].*$/, "")
    .trim();
}

function oneLiner(markdown) {
  const match = markdown.match(/##\s*1[^\n]*\n+([^\n#]+)/);
  return match ? stripInline(match[1]).slice(0, 180) : "";
}

function pageName(page) {
  const props = page.properties || {};
  const name = props.Name?.title?.map((x) => x.plain_text).join("") || "";
  const titleZh = props.TitleZh?.rich_text?.map((x) => x.plain_text).join("") || "";
  const company = props["公司名称"]?.rich_text?.map((x) => x.plain_text).join("") || "";
  return { name, titleZh, company };
}

async function listPages() {
  const results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const page = await notion(`/databases/${DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    results.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
}

function scorePage(dossierName, page) {
  const target = plain(dossierName);
  const candidates = [page.name, page.titleZh, page.company].filter(Boolean).map(plain);
  let best = 0;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === target) best = Math.max(best, 100);
    else if (candidate.includes(target) || target.includes(candidate)) {
      best = Math.max(best, 60 + Math.min(candidate.length, target.length));
    }
  }
  return best;
}

async function hasDeepDossier(pageId) {
  const blocks = await notion(`/blocks/${pageId}/children?page_size=100`);
  const text = JSON.stringify(blocks.results || []);
  return text.includes("一句话定位") || text.includes("调研日期");
}

async function appendBlocks(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 90) {
    await notion(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: blocks.slice(i, i + 90) }),
    });
  }
}

async function main() {
  if (!NOTION_TOKEN || !DB_ID) throw new Error("缺少 NOTION_TOKEN 或 NOTION_REFERENCE_DB_ID");
  if (!fs.existsSync(DOSSIER_DIR)) throw new Error(`目录不存在：${DOSSIER_DIR}`);
  const files = fs.readdirSync(DOSSIER_DIR).filter((file) => file.endsWith(".md")).sort();
  const pages = await listPages();
  console.log(`扫描 ${files.length} 份档案，Notion ${pages.length} 条`);

  for (const file of files) {
    const markdown = fs.readFileSync(path.join(DOSSIER_DIR, file), "utf8");
    const dossierName = dossierNameOf(file, markdown);
    const aliases = FILE_ALIASES[file.replace(/\.md$/, "")] || [];
    const ranked = pages
      .map((page) => {
        const found = pageName(page);
        const base = scorePage(dossierName, found);
        const aliasScore = aliases.reduce(
          (best, alias) => Math.max(best, scorePage(alias, found)),
          0,
        );
        return { page, score: Math.max(base, aliasScore) };
      })
      .sort((a, b) => b.score - a.score);
    const match = ranked[0];
    if (!match || match.score < 60) {
      console.log(`- ${file}: 未匹配到已有条目，跳过（${dossierName}）`);
      continue;
    }
    const found = pageName(match.page);
    const label = found.titleZh || found.name || dossierName;
    if (await hasDeepDossier(match.page.id)) {
      console.log(`- ${file}: ${label} 已有深度正文，跳过`);
      continue;
    }
    const blocks = markdownToBlocks(markdown);
    console.log(`- ${file}: ${label} ← ${blocks.length} 块`);
    if (DRY) continue;
    if (UPDATE_SUMMARY) {
      const summary = oneLiner(markdown);
      if (summary) {
        await notion(`/pages/${match.page.id}`, {
          method: "PATCH",
          body: JSON.stringify({ properties: { Summary: { rich_text: rich(summary) } } }),
        });
      }
    }
    await appendBlocks(match.page.id, blocks);
  }
}

main().catch((error) => {
  console.error("失败：", error.message);
  process.exit(1);
});
