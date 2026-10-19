/**
 * 外部 Reference 的正文抓取。
 *
 * Notion 里手动收藏的条目通常只有元数据，没有 page body；详情页如果只展示
 * `bodyMarkdown` 会是空页。这里在详情请求时按需抓原文，统一转成 Markdown，
 * 写 Redis 缓存，避免每次打开都回源。
 *
 * 只抓公开 http(s) 地址；拒绝 localhost / 私网，防止把服务端当 SSRF 代理。
 * 抓取失败不抛错：调用方退回到条目摘要，页面仍有内容。
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { load } from "cheerio";
import { Redis } from "@upstash/redis";
import { isProbablyPrivateOrLocalIp } from "@/lib/client-ip";

const BODY_CACHE_PREFIX = "dr:ref:body:v1:";
const BODY_FAIL_PREFIX = "dr:ref:body:fail:v1:";
const BODY_TTL_S = 7 * 24 * 60 * 60;
const FAIL_TTL_S = 60 * 60;
const MAX_HTML_BYTES = 1_600_000;
const MAX_MARKDOWN_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 7_000;

let _redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

async function isSafePublicUrl(value: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0") return null;
  if (isIP(host)) return isProbablyPrivateOrLocalIp(host) ? null : url;
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.some(({ address }) => isProbablyPrivateOrLocalIp(address))) return null;
  } catch {
    return null;
  }
  return url;
}

async function fetchText(url: string): Promise<{ text: string; contentType: string } | null> {
  const safe = await isSafePublicUrl(url);
  if (!safe) return null;
  let response: Response;
  try {
    response = await fetch(safe, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
      headers: {
        "User-Agent": "DailyRhapsody Reference Bot/1.0 (+https://tengjun.org/reference)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) return null;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_HTML_BYTES) return null;
  return { text: new TextDecoder().decode(buffer), contentType };
}

function githubRepo(url: URL): { owner: string; repo: string } | null {
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

async function readGithubReadme(url: URL): Promise<string | null> {
  const repo = githubRepo(url);
  if (!repo) return null;
  for (const name of ["README.md", "readme.md", "README.rst"]) {
    try {
      const response = await fetch(
        `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${name}`,
        {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "User-Agent": "DailyRhapsody Reference Bot/1.0" },
        },
      );
      if (response.ok) return (await response.text()).slice(0, MAX_MARKDOWN_CHARS);
    } catch {
      // try next name
    }
  }
  return null;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

function htmlToMarkdown(html: string): string {
  const $ = load(html);
  $("script,style,noscript,svg,iframe,canvas,nav,header,footer,aside,form,button").remove();

  let root = $("article").first();
  if (!root.length) root = $("main").first();
  if (!root.length) root = $("[role='main']").first();
  if (!root.length) root = $(".markdown-body").first();
  if (!root.length) root = $("body");

  const blocks: string[] = [];
  root.find("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote").each((_, el) => {
    const node = $(el);
    if (node.parents("li,blockquote").length > 0 && el.tagName !== "li") return;
    const text = cleanText(node.text());
    if (!text || text.length < 2) return;
    if (el.tagName === "h1") blocks.push(`# ${text}`);
    else if (el.tagName === "h2") blocks.push(`## ${text}`);
    else if (el.tagName === "h3") blocks.push(`### ${text}`);
    else if (el.tagName === "h4" || el.tagName === "h5" || el.tagName === "h6") blocks.push(`#### ${text}`);
    else if (el.tagName === "li") blocks.push(`- ${text}`);
    else if (el.tagName === "pre") blocks.push(`\n\`\`\`\n${text}\n\`\`\`\n`);
    else if (el.tagName === "blockquote") blocks.push(`> ${text}`);
    else blocks.push(text);
  });

  let markdown = blocks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (markdown.length < 40) {
    const bodyText = cleanText(root.text());
    markdown = bodyText.length >= 40 ? bodyText : "";
  }
  return markdown.slice(0, MAX_MARKDOWN_CHARS);
}

async function extractBody(url: string): Promise<string | null> {
  const parsed = await isSafePublicUrl(url);
  if (!parsed) return null;

  if (githubRepo(parsed)) {
    const readme = await readGithubReadme(parsed);
    if (readme) return readme;
  }

  const page = await fetchText(url);
  if (!page) return null;

  if (parsed.hostname === "arxiv.org" || parsed.hostname === "www.arxiv.org" || parsed.hostname === "export.arxiv.org") {
    const $ = load(page.text);
    const abstract = cleanText($("blockquote.abstract").first().text());
    const title = cleanText($("h1.title").first().text());
    if (abstract.length > 20) return [title && `# ${title}`, abstract].filter(Boolean).join("\n\n").slice(0, MAX_MARKDOWN_CHARS);
  }

  return htmlToMarkdown(page.text) || null;
}

export async function getFetchedReferenceBody(key: string, url: string): Promise<string | null> {
  const redis = getRedis();
  try {
    if (redis) {
      const hit = await redis.get<string>(`${BODY_CACHE_PREFIX}${key}`);
      if (typeof hit === "string" && hit.trim()) return hit;
      const failed = await redis.get(`${BODY_FAIL_PREFIX}${key}`);
      if (failed) return null;
    }
    const body = await extractBody(url);
    if (!body || body.trim().length < 40) {
      if (redis) await redis.set(`${BODY_FAIL_PREFIX}${key}`, "1", { ex: FAIL_TTL_S });
      return null;
    }
    if (redis) await redis.set(`${BODY_CACHE_PREFIX}${key}`, body, { ex: BODY_TTL_S });
    return body;
  } catch {
    return null;
  }
}
