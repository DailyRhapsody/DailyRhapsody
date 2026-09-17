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
 *   Public      Checkbox    — 是否公开（默认勾上）
 *
 * 可选属性：
 *   ClippedAt   Created time — Notion 自动；缺失时 fallback page.created_time
 *
 * 必填环境变量：
 *   NOTION_TOKEN              — 与 diaries 共用同一个 integration token
 *   NOTION_REFERENCE_DB_ID    — 32-char hex
 */

import { Client } from "@notionhq/client";
import type {
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { extractBodyMarkdown } from "@/lib/notion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReferenceItem = {
  id: string;
  name: string;
  url: string;
  source: string;
  tags: string[];
  clippedAt: string; // ISO UTC
  isPublic: boolean;
  bodyMarkdown?: string; // 仅详情接口才填，列表不返
};

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client: Client | null = null;

function getClient(): Client {
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

const LIST_CACHE_KEY = "notion:reference:items";
const ITEM_CACHE_PREFIX = "notion:reference:item:";
// Notion 自动化调 /api/revalidate 时写入；晚于列表快照开始时刻即视为过期（同 lib/notion.ts）
const LIST_INVALIDATED_KEY = "notion:reference:items:invalidatedAt";
const CACHE_STALE_MS = (Number(process.env.NOTION_CACHE_STALE_S) || 300) * 1000;
// 48h + 下限钳制：与 lib/notion.ts 同因（NOTION_CACHE_TTL 曾被误配为 300 压塌 SWR）。
const CACHE_HARD_TTL_S = 48 * 60 * 60;

function listTtl(): number {
  // Math.floor：Redis 的 EX 只接受整数，小数会让 set 被拒、缓存永远写不进去
  const configured = Math.floor(Number(process.env.NOTION_CACHE_TTL));
  if (!Number.isFinite(configured) || configured < CACHE_HARD_TTL_S) {
    return CACHE_HARD_TTL_S;
  }
  return configured;
}

type ListCacheEntry = { data: ReferenceItem[]; refreshedAt: number; snapshotAt?: number };
type CachedList = ListCacheEntry & { invalidatedAt: number };

async function getCachedList(): Promise<CachedList | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const [data, invalidatedAt] = await redis.mget<
      [ListCacheEntry | ReferenceItem[] | null, number | null]
    >(LIST_CACHE_KEY, LIST_INVALIDATED_KEY);
    if (!data) return null;
    if (Array.isArray(data)) {
      return { data, refreshedAt: 0, invalidatedAt: 0 };
    }
    if (typeof data !== "object" || !Array.isArray(data.data)) {
      return null;
    }
    return { ...data, invalidatedAt: Number(invalidatedAt) || 0 };
  } catch {
    return null;
  }
}

async function setCachedList(items: ReferenceItem[], snapshotAt: number): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const entry: ListCacheEntry = { data: items, refreshedAt: Date.now(), snapshotAt };
    await redis.set(LIST_CACHE_KEY, entry, { ex: listTtl() });
  } catch {
    // 写缓存失败不影响读取
  }
}

async function getCachedItem(id: string): Promise<ReferenceItem | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const data = await redis.get<ReferenceItem>(`${ITEM_CACHE_PREFIX}${id}`);
    if (!data || typeof data !== "object" || typeof data.id !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

async function setCachedItem(item: ReferenceItem): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    // 单条正文缓存无 SWR（过期即重拉），保持 24h 独立 TTL——不随列表硬 TTL 提到
    // 48h，否则作者改完正文最长 48h 才对外更新（列表元数据仍有 5min SWR 兜底）
    await redis.set(`${ITEM_CACHE_PREFIX}${item.id}`, item, { ex: 24 * 60 * 60 });
  } catch {
    // ignore
  }
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

function extractIsPublic(page: PageObjectResponse): boolean {
  const prop = page.properties["Public"];
  if (prop?.type === "checkbox") return prop.checkbox;
  // 缺 Public 字段的话默认公开（避免新手忘了加属性整个 DB 都不显示）
  return true;
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

function mapPageToItem(page: PageObjectResponse, bodyMarkdown?: string): ReferenceItem {
  return {
    id: page.id,
    name: extractTitle(page),
    url: extractUrl(page),
    source: extractSource(page),
    tags: extractTags(page),
    clippedAt: extractClippedAt(page),
    isPublic: extractIsPublic(page),
    ...(bodyMarkdown != null ? { bodyMarkdown } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core fetchers
// ---------------------------------------------------------------------------

let _pendingRefresh: Promise<ReferenceItem[]> | null = null;

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

  await setCachedList(items, snapshotAt);
  return items;
}

function ensureRefreshTask(): Promise<ReferenceItem[]> {
  if (!_pendingRefresh) {
    _pendingRefresh = refreshFromNotion().finally(() => {
      _pendingRefresh = null;
    });
  }
  return _pendingRefresh;
}

function triggerBackgroundRefresh(): void {
  if (_pendingRefresh) return;
  // 错误只在后台路径吞掉；同步冷路径复用同一任务时失败仍向上抛（见 notion.ts 同位置注释）
  const task = ensureRefreshTask().catch((e) => {
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
    const stale =
      Date.now() - cached.refreshedAt > CACHE_STALE_MS ||
      cached.invalidatedAt > (cached.snapshotAt ?? cached.refreshedAt);
    if (stale) triggerBackgroundRefresh();
    return cached.data;
  }
  return ensureRefreshTask();
}

/** Cron 预热入口：强制重拉并写缓存，返回条数。与用户请求共享 in-flight 去重。 */
export async function warmReferenceCache(): Promise<number> {
  const items = await ensureRefreshTask();
  return items.length;
}

/**
 * 单条详情：含 bodyMarkdown
 *  - 先查 item-level 缓存（含 body）
 *  - 未命中：同步从 Notion 拉 page meta + body，写缓存
 */
export async function getReferenceItem(id: string): Promise<ReferenceItem | null> {
  const cachedFull = await getCachedItem(id);
  if (cachedFull && cachedFull.bodyMarkdown != null) return cachedFull;

  try {
    const client = getClient();
    const page = await client.pages.retrieve({ page_id: id });
    if (!("properties" in page)) return null;

    const body = await extractBodyMarkdown(id);
    const item = mapPageToItem(page as PageObjectResponse, body);
    await setCachedItem(item);
    return item;
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
