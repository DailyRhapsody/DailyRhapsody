/**
 * Notion-backed reference store (read-only).
 *
 * 数据来源：Notion 数据库「Reference Items」。
 * 用户在 NetNewsWire 阅读 RSS → 觉得值得收藏 → 用 Notion Web Clipper 一键存进该 DB。
 * 本博客只读、缓存、按需展示。
 *
 * 必填属性（用户在 Notion 建 DB 时必须有）：
 *   Name        Title       — 文章标题
 *   URL         URL         — 原文链接
 *   Source      Select      — 站点/feed 名（Web Clipper 自动填或手填）
 *   Tag         Multi-select — 分类标签（手动）
 *   Public      Checkbox    — 是否公开（缺省 false：公开是显式动作）
 *
 * 可选属性（P0 站点有消费者的）：
 *   Type        Select      — 外部资料 / 行业评论 / 实测报告 / 访谈
 *   Domain      Multi-select — 导航定位 / 感知 / 运动控制 / 操作 / 本体与执行 /
 *                              调度与集群 / 安全与合规 / 具身智能（VLA）/ 数据与评测
 *   Year        Number      — 发表/测试/访谈年份
 *   Summary     Rich text   — 一句话结论（卡片、OG、分享卡共用）
 *   License     Select      — 自有 / 已授权 / 公开转载 / 仅链接
 *   Copyright   Rich text   — 版权归属、来源与授权说明
 *   Attachment  Files       — 自有/授权/公开转载文件（Notion 托管或外链）
 *   Cover       Files       — 可选封面；为空时回退页面 cover
 *   ClippedAt   Created time— Notion 自动；缺失时 fallback page.created_time
 *
 * 必填环境变量：
 *   NOTION_TOKEN              — 与 diaries 共用同一个 integration token
 *   NOTION_REFERENCE_DB_ID    — 32-char hex
 *
 * 缓存与签名的两条不变式：
 * 1) 缓存里只允许存稳定路径，禁止存 Notion 签名 URL（签名 1 小时过期，缓存 24–48 小时）。
 * 2) 条目结构带 schemaVersion；版本不符视为未命中，避免半结构化缓存直接进 React。
 */

import { Client } from "@notionhq/client";
import type {
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { createHash } from "node:crypto";
import { extractBodyMarkdown, withNotionRetry } from "@/lib/notion";
import { assertNotionFetchAllowed, isNotionFetchAllowed, runWithRefreshLock } from "@/lib/notion-quota";
import { mediaProxyPath, mediaVersion } from "@/lib/notion-media";
import { canonicalReferenceId } from "@/lib/reference-ids";
import type { ReferenceCompanyProfile } from "@/lib/reference-profile";
import { getFetchedReferenceBody } from "@/lib/reference-body";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const REFERENCE_SCHEMA_VERSION = 2;

export type ReferenceKind = "external" | "commentary" | "test" | "interview" | "company";
export type ReferenceLicense = "own" | "authorized" | "public" | "link-only";

export type ReferenceAttachment =
  | { kind: "file"; name: string }
  | { kind: "external"; name: string; url: string };

export type ReferenceItem = {
  id: string;
  name: string;
  /** 从正文/摘要归纳出的中文标题；没有时退回 name */
  titleZh: string | null;
  url: string;
  source: string;
  tags: string[];
  clippedAt: string; // ISO UTC
  isPublic: boolean;
  kind: ReferenceKind;
  domains: string[];
  robotTypes: string[];
  year: number | null;
  summary: string;
  license: ReferenceLicense;
  copyright: string;
  /** 稳定地址：Notion 托管封面是 /api/media/r/…；外链封面是原始 URL */
  coverPath: string | null;
  coverKind: "file" | "external" | null;
  attachment: ReferenceAttachment | null;
  /** 公司档案：仅「行业档案」类型填写，其余条目为 null */
  company: ReferenceCompanyProfile | null;
  bodyMarkdown?: string; // 仅详情接口才填，列表不返
};

export type ReferenceMediaOwner = { pageId: string; isPublic: boolean };

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client: Client | null = null;

function getClient(): Client {
  assertNotionFetchAllowed();
  if (!_client) {
    const token = process.env.NOTION_TOKEN?.trim();
    if (!token) throw new Error("NOTION_TOKEN is required");
    _client = new Client({ auth: token });
  }
  return _client;
}

function getDatabaseId(): string {
  const id = process.env.NOTION_REFERENCE_DB_ID?.trim();
  if (!id) throw new Error("NOTION_REFERENCE_DB_ID is required");
  return id;
}

// ---------------------------------------------------------------------------
// Upstash cache (SWR)
// ---------------------------------------------------------------------------

let _redis: import("@upstash/redis").Redis | null | undefined;

async function getRedis() {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) {
    const { Redis } = await import("@upstash/redis");
    _redis = new Redis({ url, token });
  } else {
    _redis = null;
  }
  return _redis;
}

// v2：字段结构变了。旧键刻意不复用，部署后第一次读取自动重建。
const LIST_CACHE_KEY = "notion:reference:items:v2";
const ITEM_CACHE_PREFIX = "notion:reference:item:v2:";
// 附件签名 URL：只在下载时换签，按 expiry 缓存；与媒体图分开
const FILE_CACHE_PREFIX = "notion:reference:file:v2:";
// Reference 正文图归属：blockId:version → pageId，供 /api/media 鉴权
const REF_MEDIA_PREFIX = "dr:ref:media:";
// Notion 自动化调 /api/revalidate 时写入；晚于列表快照开始时刻即视为过期（同 lib/notion.ts）
const LIST_INVALIDATED_KEY = "notion:reference:items:invalidatedAt";
// 跨实例刷新锁（lib/notion-quota.ts）
const REFRESH_LOCK_KEY = "notion:reference:items:refreshLock";
const CACHE_STALE_MS = (Number(process.env.NOTION_CACHE_STALE_S) || 300) * 1000;
// 48h + 下限钳制：与 lib/notion.ts 同因（NOTION_CACHE_TTL 曾被误配为 300 压塌 SWR）。
const CACHE_HARD_TTL_S = 48 * 60 * 60;
// 单条正文缓存 24h；正文里的图片是稳定代理路径，不随签名过期
const ITEM_TTL_S = 24 * 60 * 60;
// 正文图归属键比单条缓存多留 5 分钟，避免条目缓存刚好过期时图片 404
const REF_MEDIA_TTL_S = ITEM_TTL_S + 5 * 60;
const SIGNED_URL_SAFETY_S = 60;

function listTtl(): number {
  // Math.floor：Redis 的 EX 只接受整数，小数会让 set 被拒、缓存永远写不进去
  const configured = Math.floor(Number(process.env.NOTION_CACHE_TTL));
  if (!Number.isFinite(configured) || configured < CACHE_HARD_TTL_S) {
    return CACHE_HARD_TTL_S;
  }
  return configured;
}

type ListCacheEntry = {
  schemaVersion: typeof REFERENCE_SCHEMA_VERSION;
  data: ReferenceItem[];
  refreshedAt: number;
  snapshotAt?: number;
};
type ItemCacheEntry = {
  schemaVersion: typeof REFERENCE_SCHEMA_VERSION;
  item: ReferenceItem;
};
type CachedList = ListCacheEntry & { invalidatedAt: number };

/** Notion SDK 2.3.0 没有导出统一的 FileObjectResponse，这里按实际响应收窄。 */
type NotionFileValue = {
  type?: "file" | "external";
  file?: { url: string; expiry_time: string };
  external?: { url: string };
  name?: string;
};

function isReferenceKind(value: unknown): value is ReferenceKind {
  return (
    value === "external" ||
    value === "commentary" ||
    value === "test" ||
    value === "interview" ||
    value === "company"
  );
}

function isReferenceLicense(value: unknown): value is ReferenceLicense {
  return value === "own" || value === "authorized" || value === "public" || value === "link-only";
}

function isReferenceAttachment(value: unknown): value is ReferenceAttachment | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<ReferenceAttachment>;
  if (a.kind === "file") return typeof a.name === "string";
  if (a.kind === "external") return typeof a.name === "string" && typeof a.url === "string";
  return false;
}

function isReferenceCompanyProfile(value: unknown): value is ReferenceCompanyProfile {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<ReferenceCompanyProfile>;
  return (
    typeof c.companyName === "string" &&
    (c.headcount === null || typeof c.headcount === "number") &&
    typeof c.operationCulture === "string" &&
    Array.isArray(c.productForms) &&
    c.productForms.every((x) => typeof x === "string") &&
    Array.isArray(c.markets) &&
    c.markets.every((x) => typeof x === "string") &&
    Array.isArray(c.scenarios) &&
    c.scenarios.every((x) => typeof x === "string") &&
    Array.isArray(c.companyTags) &&
    c.companyTags.every((x) => typeof x === "string") &&
    typeof c.interviewStatus === "string" &&
    Array.isArray(c.salesModes) &&
    c.salesModes.every((x) => typeof x === "string") &&
    typeof c.listed === "string" &&
    typeof c.profitability === "string"
  );
}

/**
 * 缓存读回来的条目必须过这一层。少了它，字段改名/半结构化条目会直接把
 * `item.domains.map` 之类调用抛成 500，而不是回退到 Notion 重拉。
 */
function isReferenceItem(value: unknown): value is ReferenceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReferenceItem>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.url === "string" &&
    typeof item.source === "string" &&
    Array.isArray(item.tags) &&
    item.tags.every((t) => typeof t === "string") &&
    typeof item.clippedAt === "string" &&
    typeof item.isPublic === "boolean" &&
    isReferenceKind(item.kind) &&
    Array.isArray(item.domains) &&
    item.domains.every((d) => typeof d === "string") &&
    (item.robotTypes === undefined ||
      (Array.isArray(item.robotTypes) && item.robotTypes.every((t) => typeof t === "string"))) &&
    (item.year === null || typeof item.year === "number") &&
    typeof item.summary === "string" &&
    isReferenceLicense(item.license) &&
    typeof item.copyright === "string" &&
    (item.coverPath === null || typeof item.coverPath === "string") &&
    (item.coverKind === null || item.coverKind === "file" || item.coverKind === "external") &&
    isReferenceAttachment(item.attachment) &&
    (item.company === undefined || item.company === null || isReferenceCompanyProfile(item.company)) &&
    (item.bodyMarkdown === undefined || typeof item.bodyMarkdown === "string")
  );
}

async function getCachedList(): Promise<CachedList | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const [data, invalidatedAt] = await redis.mget<
      [ListCacheEntry | null, number | null]
    >(LIST_CACHE_KEY, LIST_INVALIDATED_KEY);
    if (!data || typeof data !== "object" || data.schemaVersion !== REFERENCE_SCHEMA_VERSION) {
      return null;
    }
    if (!Array.isArray(data.data)) return null;
    if (!data.data.every(isReferenceItem)) return null;
    return { ...data, invalidatedAt: Number(invalidatedAt) || 0 };
  } catch {
    return null;
  }
}

async function setCachedList(items: ReferenceItem[], snapshotAt: number): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const entry: ListCacheEntry = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      data: items,
      refreshedAt: Date.now(),
      snapshotAt,
    };
    await redis.set(LIST_CACHE_KEY, entry, { ex: listTtl() });
  } catch {
    // 写缓存失败不影响读取
  }
}

async function getCachedItem(id: string): Promise<ReferenceItem | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const data = await redis.get<ItemCacheEntry>(`${ITEM_CACHE_PREFIX}${id}`);
    if (!data || typeof data !== "object" || data.schemaVersion !== REFERENCE_SCHEMA_VERSION) {
      return null;
    }
    return isReferenceItem(data.item) ? data.item : null;
  } catch {
    return null;
  }
}

async function setCachedItem(item: ReferenceItem): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const entry: ItemCacheEntry = { schemaVersion: REFERENCE_SCHEMA_VERSION, item };
    await redis.set(`${ITEM_CACHE_PREFIX}${item.id}`, entry, { ex: ITEM_TTL_S });
    if (item.bodyMarkdown) await recordReferenceMedia(item.id, item.bodyMarkdown);
  } catch {
    // ignore
  }
}

/**
 * 正文图走 /api/media/b/<blockId>/<version>，媒体路由需要知道这张图属于哪一条。
 * 记 blockId:version → pageId，媒体路由再查该条目的公开性。
 * 失败不阻塞正文缓存；图最多 404，不会泄露私密内容。
 */
async function recordReferenceMedia(pageId: string, bodyMarkdown: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  const re = /\/api\/media\/b\/([0-9a-f]{32})\/([0-9a-f]{10})/g;
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyMarkdown)) !== null) {
    keys.push(`${REF_MEDIA_PREFIX}${m[1]}:${m[2]}`);
  }
  if (keys.length === 0) return;
  const pipe = redis.pipeline();
  for (const key of keys) pipe.set(key, pageId, { ex: REF_MEDIA_TTL_S });
  await pipe.exec();
}

/**
 * Notion 自动化调用：列表记下过期时间并立即后台重拉（期间访客继续看旧数据）；
 * 单条正文缓存没有 SWR，单条回源很快，照旧删除。
 */
export async function markReferenceCacheStale(): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(LIST_INVALIDATED_KEY, Date.now(), { ex: listTtl() });
    triggerBackgroundRefresh();
    let cursor: string = "0";
    do {
      const [next, keys]: [string, string[]] = await redis.scan(cursor, {
        match: `${ITEM_CACHE_PREFIX}*`,
        count: 100,
      });
      if (keys.length > 0) await redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Notion property helpers
// ---------------------------------------------------------------------------

function richTextToPlain(items: RichTextItemResponse[]): string {
  return items.map((i) => i.plain_text).join("");
}

function extractTitle(page: PageObjectResponse): string {
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop.type === "title") {
      return richTextToPlain(prop.title);
    }
  }
  return "";
}

function extractUrl(page: PageObjectResponse): string {
  const prop = page.properties["URL"];
  if (prop?.type === "url") return prop.url ?? "";
  return "";
}

function extractTitleZh(page: PageObjectResponse): string | null {
  const prop = page.properties["TitleZh"];
  if (prop?.type === "rich_text") {
    const text = richTextToPlain(prop.rich_text).trim();
    return text || null;
  }
  return null;
}

function extractTextProp(page: PageObjectResponse, name: string): string {
  const prop = page.properties[name];
  if (prop?.type === "rich_text") return richTextToPlain(prop.rich_text).trim();
  if (prop?.type === "title") return richTextToPlain(prop.title).trim();
  return "";
}

function extractMultiProp(page: PageObjectResponse, name: string): string[] {
  const prop = page.properties[name];
  if (prop?.type === "multi_select") return prop.multi_select.map((x) => x.name);
  return [];
}

function extractSelectProp(page: PageObjectResponse, name: string): string {
  const prop = page.properties[name];
  if (prop?.type === "select") return prop.select?.name ?? "";
  return "";
}

function extractNumberProp(page: PageObjectResponse, name: string): number | null {
  const prop = page.properties[name];
  if (prop?.type !== "number" || typeof prop.number !== "number" || !Number.isFinite(prop.number)) {
    return null;
  }
  return Math.trunc(prop.number);
}

function extractCompany(page: PageObjectResponse): ReferenceCompanyProfile | null {
  const companyName = extractTextProp(page, "公司名称");
  const company: ReferenceCompanyProfile = {
    companyName,
    headcount: extractNumberProp(page, "业务人数"),
    operationCulture: extractSelectProp(page, "运营文化"),
    productForms: extractMultiProp(page, "产品形态"),
    markets: extractMultiProp(page, "市场位置"),
    scenarios: extractMultiProp(page, "场景定位"),
    companyTags: extractMultiProp(page, "公司标签"),
    interviewStatus: extractSelectProp(page, "是否通过面试"),
    salesModes: extractMultiProp(page, "售卖形态"),
    listed: extractSelectProp(page, "是否上市"),
    profitability: extractSelectProp(page, "业务盈亏"),
  };
  const hasData =
    company.companyName ||
    company.headcount !== null ||
    company.operationCulture ||
    company.productForms.length ||
    company.markets.length ||
    company.scenarios.length ||
    company.companyTags.length ||
    company.interviewStatus ||
    company.salesModes.length ||
    company.listed ||
    company.profitability;
  return hasData ? company : null;
}

function extractSource(page: PageObjectResponse): string {
  const prop = page.properties["Source"];
  if (prop?.type === "select") return prop.select?.name ?? "";
  if (prop?.type === "rich_text") return richTextToPlain(prop.rich_text);
  return "";
}

function extractTags(page: PageObjectResponse): string[] {
  // 同时支持 "Tag" / "Tags" 两种命名（用户在 Notion 里两种都常见）
  const prop = page.properties["Tag"] ?? page.properties["Tags"];
  if (prop?.type === "multi_select") {
    return prop.multi_select.map((t) => t.name);
  }
  return [];
}

/**
 * 缺 Public 时返回 false：公开必须是显式动作。
 * Reference 是公开资料库，fail-open 会把草稿/私密条目直接暴露出去。
 */
function extractIsPublic(page: PageObjectResponse): boolean {
  const prop = page.properties["Public"];
  if (prop?.type === "checkbox") return prop.checkbox;
  return false;
}

export function referenceTagCounts(items: ReferenceItem[]): { name: string; value: number }[] {
  const count = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      count.set(tag, (count.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(count.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

function extractClippedAt(page: PageObjectResponse): string {
  const prop = page.properties["ClippedAt"];
  if (prop?.type === "created_time") return prop.created_time;
  if (prop?.type === "date" && prop.date?.start) {
    return prop.date.start.length > 10
      ? new Date(prop.date.start).toISOString()
      : new Date(`${prop.date.start}T00:00:00Z`).toISOString();
  }
  return page.created_time;
}

function extractKind(page: PageObjectResponse): ReferenceKind {
  const prop = page.properties["Type"];
  const name = prop?.type === "select" ? prop.select?.name ?? "" : "";
  // 也接受英文值，方便 API 直接写入
  if (name === "行业档案" || name === "company") return "company";
  if (name === "行业评论" || name === "commentary") return "commentary";
  if (name === "实测报告" || name === "test") return "test";
  if (name === "访谈" || name === "interview") return "interview";
  return "external";
}

function extractDomains(page: PageObjectResponse): string[] {
  const prop = page.properties["Domain"];
  if (prop?.type === "multi_select") return prop.multi_select.map((d) => d.name);
  return [];
}

function extractRobotTypes(page: PageObjectResponse): string[] {
  const prop = page.properties["RobotType"];
  if (prop?.type === "multi_select") return prop.multi_select.map((t) => t.name);
  return [];
}

function extractYear(page: PageObjectResponse): number | null {
  const prop = page.properties["Year"];
  if (prop?.type !== "number") return null;
  const n = prop.number;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  // Notion 里可能填 2026.0 / 26；只收合理年份，避免把 26 当 26 年
  if (n < 1900 || n > 2100) return null;
  return Math.trunc(n);
}

function extractSummary(page: PageObjectResponse): string {
  const prop = page.properties["Summary"];
  if (prop?.type === "rich_text") return richTextToPlain(prop.rich_text).trim();
  return "";
}

function extractLicense(page: PageObjectResponse): ReferenceLicense {
  const prop = page.properties["License"];
  const name = prop?.type === "select" ? prop.select?.name ?? "" : "";
  if (name === "自有" || name === "own") return "own";
  if (name === "已授权" || name === "authorized") return "authorized";
  if (name === "公开转载" || name === "public") return "public";
  return "link-only";
}

function extractCopyright(page: PageObjectResponse): string {
  const prop = page.properties["Copyright"];
  if (prop?.type === "rich_text") return richTextToPlain(prop.rich_text).trim();
  return "";
}

function firstFilesProp(page: PageObjectResponse, name: string): NotionFileValue | null {
  const prop = page.properties[name];
  if (prop?.type !== "files") return null;
  return (prop.files[0] as NotionFileValue | undefined) ?? null;
}

function extractCover(
  page: PageObjectResponse
): { path: string; kind: "file" | "external" } | null {
  // 优先 Cover 属性，其次页面 cover。Notion 托管的只存稳定代理路径，
  // 绝不把 1h 签名地址写进 48h 列表缓存。
  const file = firstFilesProp(page, "Cover") ?? (page.cover as NotionFileValue | null) ?? null;
  if (!file) return null;
  if (file.type === "file" && file.file) {
    return { path: mediaProxyPath("r", page.id, file.file.url), kind: "file" };
  }
  if (file.type === "external" && file.external) {
    return { path: file.external.url, kind: "external" };
  }
  return null;
}

function extractAttachment(page: PageObjectResponse): ReferenceAttachment | null {
  const file = firstFilesProp(page, "Attachment");
  if (!file) return null;
  if (file.type === "file" && file.file) {
    return { kind: "file", name: file.name ?? "附件" };
  }
  if (file.type === "external" && file.external) {
    return { kind: "external", name: file.name ?? "附件", url: file.external.url };
  }
  return null;
}

function mapPageToItem(page: PageObjectResponse, bodyMarkdown?: string): ReferenceItem {
  const cover = extractCover(page);
  return {
    id: page.id,
    name: extractTitle(page),
    titleZh: extractTitleZh(page),
    url: extractUrl(page),
    source: extractSource(page),
    tags: extractTags(page),
    clippedAt: extractClippedAt(page),
    isPublic: extractIsPublic(page),
    kind: extractKind(page),
    domains: extractDomains(page),
    robotTypes: extractRobotTypes(page),
    year: extractYear(page),
    summary: extractSummary(page),
    license: extractLicense(page),
    copyright: extractCopyright(page),
    coverPath: cover?.path ?? null,
    coverKind: cover?.kind ?? null,
    attachment: extractAttachment(page),
    company: extractCompany(page),
    ...(bodyMarkdown != null ? { bodyMarkdown } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core fetchers
// ---------------------------------------------------------------------------

let _pendingRefresh: Promise<ReferenceItem[] | null> | null = null;

async function refreshFromNotion(): Promise<ReferenceItem[]> {
  const client = getClient();
  const databaseId = getDatabaseId();
  const snapshotAt = Date.now();

  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    // 列表查询不取 body（详情请求时按需拉），节省 Notion API 调用
    const response = await client.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of response.results) {
      if ("properties" in page) {
        pages.push(page as PageObjectResponse);
      }
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  const items = pages.map((p) => mapPageToItem(p));
  // 按 ClippedAt 倒序
  items.sort(
    (a, b) => new Date(b.clippedAt).getTime() - new Date(a.clippedAt).getTime()
  );

  // 列表已经拿到封面签名地址，顺手预热媒体缓存，避免首屏 N 张封面各自回源
  await warmCoverCache(pages);
  await setCachedList(items, snapshotAt);
  return items;
}

/**
 * 列表查询已经拿到了封面签名地址。顺手把它写进媒体代理的缓存键，
 * 首屏 N 张封面就不用每张再回源 Notion（共享 token 约 3 req/s，冷启动必 429）。
 * key 形状必须与 lib/notion.ts 的 resolveNotionFileUrl 完全一致。
 */
async function warmCoverCache(pages: PageObjectResponse[]): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  const pipe = redis.pipeline();
  let count = 0;
  for (const page of pages) {
    const file = firstFilesProp(page, "Cover") ?? (page.cover as NotionFileValue | null);
    if (file?.type !== "file" || !file.file) continue;
    const ttlS =
      Math.floor((new Date(file.file.expiry_time).getTime() - Date.now()) / 1000) -
      SIGNED_URL_SAFETY_S;
    if (!Number.isFinite(ttlS) || ttlS < 60) continue;
    const id = page.id.replace(/-/g, "");
    const key = `notion:media:v2:r:${id}:${mediaVersion(file.file.url)}`;
    pipe.set(key, { url: file.file.url, media: "image" }, { ex: ttlS });
    count += 1;
  }
  if (count > 0) {
    try {
      await pipe.exec();
    } catch {
      // 预热失败不影响列表本身；媒体路由会回源换签
    }
  }
}

/** 返回 null：后台刷新没拿到跨实例锁（见 lib/notion.ts 同名函数）。 */
function ensureRefreshTask(force: boolean): Promise<ReferenceItem[] | null> {
  if (!_pendingRefresh) {
    _pendingRefresh = getRedis()
      .then((redis) => {
        // 配置缺失在拿锁前抛出，不给共享的锁写冷却期（见 lib/notion.ts 同位置）
        getClient();
        getDatabaseId();
        return runWithRefreshLock(redis, REFRESH_LOCK_KEY, force, refreshFromNotion);
      })
      .finally(() => {
        _pendingRefresh = null;
      });
  }
  return _pendingRefresh;
}

/** 同步路径（冷启动、Cron）一定要拿到数据（见 lib/notion.ts 同名函数）。 */
async function refreshNow(): Promise<ReferenceItem[]> {
  for (;;) {
    const items = await ensureRefreshTask(true);
    if (items !== null) return items;
  }
}

function triggerBackgroundRefresh(): void {
  if (_pendingRefresh) return;
  if (!isNotionFetchAllowed()) return;
  // 错误只在后台路径吞掉；同步冷路径复用同一任务时失败仍向上抛（见 notion.ts 同位置注释）
  const task = ensureRefreshTask(false).catch((e) => {
    console.warn("[notion-reference] background refresh failed:", e);
    return [] as ReferenceItem[];
  });
  import("@vercel/functions").then(({ waitUntil }) => waitUntil(task)).catch(() => {
    // 非 Vercel runtime：fire-and-forget
  });
}

/**
 * 列表：SWR 策略
 *  - 有缓存：立即返回；超过 stale 阈值则后台异步刷新
 *  - 无缓存：同步拉取并缓存
 */
export async function getReferenceItems(): Promise<ReferenceItem[]> {
  const cached = await getCachedList();
  if (cached) {
    // 公开性/正文被显式标记失效时必须同步换新：这里不能再走 SWR 返回旧快照，
    // 否则取消 Public 的条目在下载/评论/点赞路径上还会被当成公开。
    if (cached.invalidatedAt > (cached.snapshotAt ?? cached.refreshedAt)) {
      return refreshNow();
    }
    if (Date.now() - cached.refreshedAt > CACHE_STALE_MS) triggerBackgroundRefresh();
    return cached.data;
  }
  return refreshNow();
}

/**
 * 只读缓存：不触发 Notion。首屏 SSR、媒体鉴权、评论存在性检查都用它，
 * 避免一次页面请求把 3 req/s 的共享额度打满。
 */
export async function getCachedReferenceItems(): Promise<ReferenceItem[] | null> {
  const cached = await getCachedList();
  if (!cached) return null;
  // 显式失效（Notion 自动化改了公开性/正文）后，鉴权与首屏都不能再拿旧快照，
  // 否则取消 Public 的条目最长 48h 仍可下载/评论/点赞。
  if (cached.invalidatedAt > (cached.snapshotAt ?? cached.refreshedAt)) return null;
  return cached.data;
}

/** Cron 预热入口：强制重拉并写缓存，返回条数。与用户请求共享 in-flight 去重。 */
export async function warmReferenceCache(): Promise<number> {
  const items = await refreshNow();
  return items.length;
}

/** 从单条缓存或列表缓存取一条，不触发 Notion。id 的两种写法先规范化。 */
export async function getCachedReferenceItem(id: string): Promise<ReferenceItem | null> {
  const canonical = canonicalReferenceId(id);
  const list = await getCachedList();
  if (list && list.invalidatedAt > (list.snapshotAt ?? list.refreshedAt)) return null;
  const item = await getCachedItem(canonical);
  if (item) return item;
  const items = list?.data ?? (await getCachedReferenceItems());
  return items?.find((i) => canonicalReferenceId(i.id) === canonical) ?? null;
}

/**
 * 单条详情：含 bodyMarkdown
 *  - 先查 item-level 缓存（含 body）
 *  - 未命中：同步从 Notion 拉 page meta + body，写缓存
 */
export async function getReferenceItem(id: string): Promise<ReferenceItem | null> {
  const pageId = canonicalReferenceId(id);
  const cachedFull = await getCachedItem(pageId);
  // 旧缓存可能只有元数据、正文为空；空正文要继续走原文抓取，不能直接返回。
  if (cachedFull && cachedFull.bodyMarkdown?.trim()) return cachedFull;

  try {
    const client = getClient();
    const page = await withNotionRetry(
      () => client.pages.retrieve({ page_id: pageId }),
      Date.now() + 20_000,
    );
    if (!("properties" in page)) return null;

    // proxyMedia：正文图输出稳定 /api/media/b/… 路径，签名过期不会裂图。
    // 归属由 recordReferenceMedia 记录，/api/media 鉴权时再查本条目的公开性。
    const notionBody = await extractBodyMarkdown(pageId, { proxyMedia: true });
    const item = mapPageToItem(page as PageObjectResponse, notionBody ?? "");

    // 手动收藏的 Reference 大多没有 Notion page body：按需抓原文正文。
    // 抓不到时也展示摘要，页面不再只剩“正文为空”。
    let hasCachedBody = Boolean(notionBody?.trim());
    if (!hasCachedBody) {
      const fetched = await getFetchedReferenceBody(pageId, item.url);
      if (fetched?.trim()) {
        item.bodyMarkdown = fetched;
        hasCachedBody = true;
      }
    }
    if (!item.bodyMarkdown?.trim() && item.summary) {
      item.bodyMarkdown = `## 资料摘要\n\n${item.summary}\n\n> 原站未返回可提取正文，以上为本站摘要。`;
    }

    // 真实正文才写 24h item 缓存；摘要兜底不缓存，下次请求继续尝试抓原文。
    if (hasCachedBody) await setCachedItem(item);
    return item;
  } catch {
    // Notion 限流/超时/预算耗尽时，已知条目不能当作 404：它已在 sitemap 里，
    // 一次 429 就让爬虫记成已删除。回退列表缓存里的元数据，正文留空，下次再补。
    return getCachedReferenceItem(pageId);
  }
}

/**
 * 页面 cover / 正文图的归属查询，供 /api/media 鉴权。
 * 只认 Reference 缓存，不接受调用方传入的“我是公开的”声明。
 */
export async function getReferenceMediaOwner(pageId: string): Promise<ReferenceMediaOwner | null> {
  const item = await getCachedReferenceItem(pageId);
  if (!item) return null;
  return { pageId: item.id, isPublic: item.isPublic };
}

/**
 * 正文图的 blockId:version → pageId 映射。返回 null 表示这张图不是 Reference 正文图；
 * 返回 owner 后调用方仍要按 isPublic 决定 public/private。
 */
export async function getReferenceBodyMediaOwner(
  blockId: string,
  version: string
): Promise<ReferenceMediaOwner | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const pageId = await redis.get<string>(`${REF_MEDIA_PREFIX}${blockId}:${version}`);
    if (typeof pageId !== "string" || !pageId) return null;
    return getReferenceMediaOwner(pageId);
  } catch {
    return null;
  }
}

/**
 * 下载附件换签。缓存里的不是 URL，而是 pageId；每次按 expiry 重新取签名地址，
 * 避免 1 小时过期后下载 403。返回 null 表示没有可下载附件。
 */
export async function getReferenceAttachmentUrl(
  pageId: string
): Promise<{ url: string; name: string } | null> {
  const canonical = canonicalReferenceId(pageId);
  const redis = await getRedis();
  if (redis) {
    try {
      const hit = await redis.get<{ url: string; name: string }>(`${FILE_CACHE_PREFIX}${canonical}`);
      if (hit?.url) return hit;
    } catch {
      // 当作未命中
    }
  }

  try {
    const client = getClient();
    const page = await withNotionRetry(
      () => client.pages.retrieve({ page_id: canonical }),
      Date.now() + 20_000,
    );
    if (!("properties" in page)) return null;
    const file = firstFilesProp(page as PageObjectResponse, "Attachment");
    if (!file) return null;

    let url: string;
    let name: string;
    if (file.type === "file" && file.file) {
      url = file.file.url;
      name = file.name ?? "附件";
      const expiry = new Date(file.file.expiry_time).getTime();
      const ttlS = Math.floor((expiry - Date.now()) / 1000) - SIGNED_URL_SAFETY_S;
      if (redis && ttlS >= 60) {
        try {
          await redis.set(`${FILE_CACHE_PREFIX}${canonical}`, { url, name }, { ex: ttlS });
        } catch {
          // non-fatal
        }
      }
    } else if (file.type === "external" && file.external) {
      url = file.external.url;
      name = file.name ?? "附件";
    } else {
      return null;
    }
    return { url, name };
  } catch {
    return null;
  }
}

export function isReferenceConfigured(): boolean {
  return !!(
    process.env.NOTION_TOKEN?.trim() &&
    process.env.NOTION_REFERENCE_DB_ID?.trim()
  );
}

/** 下载计数：按 IP 日去重，只加总数，不记用户；失败不影响 302。 */
export async function recordReferenceDownload(id: string, ip: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 16);
    const dedupe = `dr:ref:dl:${id}:${day}:${ipHash}`;
    const first = await redis.set(dedupe, "1", { nx: true, ex: 24 * 60 * 60 });
    if (first === "OK") await redis.incr(`dr:ref:dl:${id}`);
  } catch {
    // ignore
  }
}
