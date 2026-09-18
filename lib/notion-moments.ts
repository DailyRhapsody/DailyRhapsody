/**
 * Notion-backed moments store (read-only).
 *
 * Unified data source for the moments tab.
 * Reads from a Notion database with properties:
 *   Name (title), Date (date), Public (checkbox)
 *
 * 媒体（图片/视频）从页面正文 block 提取（不再使用 Images files 字段）：
 *   - 视频优先：正文有任何 video block，type=2，取首个视频
 *   - 否则：按 block 顺序收集 image block，最多 9 张
 *
 * Outputs PublicMoment format compatible with the frontend.
 *
 * Env: NOTION_MOMENTS_DATABASE_ID
 */

import { Client } from "@notionhq/client";
import type {
  BlockObjectResponse,
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { mediaProxyPath } from "@/lib/notion-media";
import type { MomentOutlineItem } from "@/components/entries/types";

// Match the frontend PublicMoment / PublicMedia types
export type PublicMedia = {
  url: string;
  thumbUrl: string;
  mediaType: string;
  width: number;
  height: number;
  duration: number;
  sortOrder: number;
};

export type PublicMoment = {
  id: string;
  type: 1 | 2;
  createdAt: string;
  media: PublicMedia[];
};

// Also export a legacy MomentsItem shape for backwards compatibility
export type MomentsItem = {
  id: string;
  createdAt: string;
  isPublic?: boolean;
  images: string[];
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
  const id = (process.env.NOTION_MOMENTS_DATABASE_ID ?? process.env.NOTION_GALLERY_DATABASE_ID)?.trim();
  if (!id) throw new Error("NOTION_MOMENTS_DATABASE_ID is required");
  return id;
}

// ---------------------------------------------------------------------------
// Upstash cache
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

// v2 / invalidatedAt：与 lib/notion.ts 同因（媒体改存代理路径，Preview 与生产共用 Upstash）
const CACHE_KEY = "notion:moments:v2";
const LEGACY_CACHE_KEY = "notion:moments";
const INVALIDATED_KEY = "notion:moments:v2:invalidatedAt";
const CACHE_STALE_MS = (Number(process.env.NOTION_CACHE_STALE_S) || 300) * 1000;
// 48h + 下限钳制：与 lib/notion.ts 同因（NOTION_CACHE_TTL 曾被误配为 300 压塌 SWR）。
const CACHE_HARD_TTL_S = 48 * 60 * 60;

function cacheTtl(): number {
  // Math.floor：Redis 的 EX 只接受整数，小数会让 set 被拒、缓存永远写不进去
  const configured = Math.floor(Number(process.env.NOTION_CACHE_TTL));
  if (!Number.isFinite(configured) || configured < CACHE_HARD_TTL_S) {
    return CACHE_HARD_TTL_S;
  }
  return configured;
}

type MomentWithVisibility = PublicMoment & { isPublic: boolean };
type CacheEntry = { data: MomentWithVisibility[]; refreshedAt: number; snapshotAt?: number };
type CachedMoments = CacheEntry & { invalidatedAt: number };

function parseEntry(data: CacheEntry | MomentWithVisibility[] | null): CacheEntry | null {
  if (!data) return null;
  if (Array.isArray(data)) return { data, refreshedAt: 0 };
  // 损坏数据保护：见 notion.ts 同位置注释。
  if (typeof data !== "object" || !Array.isArray(data.data)) return null;
  return data;
}

async function getCached(opts: { legacyFallback?: boolean } = {}): Promise<CachedMoments | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const [raw, invalidatedAt] = await redis.mget<
      [CacheEntry | MomentWithVisibility[] | null, number | null]
    >(CACHE_KEY, INVALIDATED_KEY);
    const entry = parseEntry(raw);
    if (entry) return { ...entry, invalidatedAt: Number(invalidatedAt) || 0 };
    if (opts.legacyFallback === false) return null;
    const legacy = parseEntry(await redis.get<CacheEntry | MomentWithVisibility[]>(LEGACY_CACHE_KEY));
    return legacy ? { data: legacy.data, refreshedAt: 0, invalidatedAt: 0 } : null;
  } catch {
    return null;
  }
}

function isStale(cached: CachedMoments): boolean {
  if (Date.now() - cached.refreshedAt > CACHE_STALE_MS) return true;
  return cached.invalidatedAt > (cached.snapshotAt ?? cached.refreshedAt);
}

async function setCache(items: MomentWithVisibility[], snapshotAt: number): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const entry: CacheEntry = { data: items, refreshedAt: Date.now(), snapshotAt };
    await redis.set(CACHE_KEY, entry, { ex: cacheTtl() });
  } catch {
    // non-fatal
  }
}

/** Notion 自动化调用：记下过期时间并立即后台重拉（同 lib/notion.ts markDiariesCacheStale）。 */
export async function markMomentsCacheStale(): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(INVALIDATED_KEY, Date.now(), { ex: cacheTtl() });
  } catch {
    return;
  }
  triggerBackgroundRefresh();
}

/** 只读缓存、不触发重拉，供 /api/media 鉴权用。 */
export async function getCachedMoments(): Promise<MomentWithVisibility[] | null> {
  return (await getCached({ legacyFallback: false }))?.data ?? null;
}

// ---------------------------------------------------------------------------
// Property extraction
// ---------------------------------------------------------------------------

const MAX_IMAGES_PER_MOMENT = 9;

// Notion 托管文件的签名地址 1 小时过期，缓存里只存站内代理路径（见 lib/notion-media.ts）
function blockMediaUrl(block: BlockObjectResponse): string | null {
  if (block.type === "image") {
    const f = block.image;
    if (f.type === "file") return mediaProxyPath("b", block.id, f.file.url);
    if (f.type === "external") return f.external.url;
  } else if (block.type === "video") {
    const f = block.video;
    if (f.type === "file") return mediaProxyPath("b", block.id, f.file.url);
    if (f.type === "external") return f.external.url;
  }
  return null;
}

/**
 * 从 Notion 页面正文 block 提取图片/视频。
 * 规则（与产品定义一致）：
 *  - 一条 moment 是纯图或纯视频，不带文字
 *  - 视频优先：只要正文里有任何 video block，type=2，取首个视频
 *  - 否则按 block 顺序收集 image block，最多 9 张
 *
 * 旧字段 properties.Images 不再使用——用户会在 Notion 后台清空那个字段。
 */
async function extractMediaFromBody(pageId: string): Promise<PublicMedia[]> {
  const client = getClient();
  const imageBlocks: BlockObjectResponse[] = [];
  let firstVideo: BlockObjectResponse | null = null;

  // 递归遍历 block 树（限深度，处理 column_list / toggle / synced_block 等容器）
  async function walk(blockId: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let cursor: string | undefined;
    do {
      const r = await client.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const b of r.results) {
        if (!("type" in b)) continue;
        const block = b as BlockObjectResponse;
        if (block.type === "video" && !firstVideo) {
          firstVideo = block;
        } else if (block.type === "image") {
          imageBlocks.push(block);
        }
        if (block.has_children) {
          await walk(block.id, depth + 1);
        }
      }
      cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
    } while (cursor);
  }

  try {
    await walk(pageId, 0);
  } catch (e) {
    console.warn(`[notion-moments] extractMediaFromBody failed for ${pageId}:`, e);
    return [];
  }

  // 视频优先
  if (firstVideo) {
    const url = blockMediaUrl(firstVideo);
    if (!url) return [];
    return [{
      url,
      thumbUrl: url,
      mediaType: "video/mp4",
      width: 0,
      height: 0,
      duration: 0,
      sortOrder: 0,
    }];
  }

  // 无视频：按顺序最多 9 张图片
  return imageBlocks
    .slice(0, MAX_IMAGES_PER_MOMENT)
    .map((b, idx): PublicMedia | null => {
      const url = blockMediaUrl(b);
      if (!url) return null;
      return {
        url,
        thumbUrl: url,
        mediaType: "image/jpeg",
        width: 0,
        height: 0,
        duration: 0,
        sortOrder: idx,
      };
    })
    .filter((x): x is PublicMedia => x !== null);
}

/**
 * 并发抓多页 body 的媒体。Notion API 没有官方 RPS 文档但实测 3 并发安全；
 * 与 lib/notion.ts 的 extractBodyMarkdownBatch 保持一致。
 */
async function extractMediaBatch(
  pageIds: string[],
  concurrency = 3
): Promise<Map<string, PublicMedia[]>> {
  const out = new Map<string, PublicMedia[]>();
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, pageIds.length) }, async () => {
    while (idx < pageIds.length) {
      const i = idx++;
      const id = pageIds[i];
      out.set(id, await extractMediaFromBody(id));
    }
  });
  await Promise.all(workers);
  return out;
}

function extractDate(page: PageObjectResponse): string {
  const prop = page.properties["Date"];
  if (prop?.type === "date" && prop.date?.start) {
    return new Date(prop.date.start).toISOString();
  }
  return page.created_time;
}

function extractIsPublic(page: PageObjectResponse): boolean {
  const prop = page.properties["Public"];
  if (prop?.type === "checkbox") return prop.checkbox;
  return true;
}

function mapPageToMoment(
  page: PageObjectResponse,
  media: PublicMedia[]
): PublicMoment & { isPublic: boolean } {
  const hasVideo = media.some((m) => m.mediaType.startsWith("video/"));

  return {
    id: page.id,
    type: hasVideo ? 2 : 1,
    createdAt: extractDate(page),
    isPublic: extractIsPublic(page),
    media,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all moments from Notion, sorted by date descending.
 * Returns PublicMoment[] with an extra isPublic field for filtering.
 */
async function refreshMomentsFromNotion(): Promise<(PublicMoment & { isPublic: boolean })[]> {
  const client = getClient();
  const databaseId = getDatabaseId();
  const snapshotAt = Date.now();

  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
      sorts: [{ property: "Date", direction: "descending" }],
    });
    for (const page of response.results) {
      if ("properties" in page) {
        pages.push(page as PageObjectResponse);
      }
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  const mediaMap = await extractMediaBatch(pages.map((p) => p.id));
  const items = pages.map((page) => mapPageToMoment(page, mediaMap.get(page.id) ?? []));
  await setCache(items, snapshotAt);
  return items;
}

// 正在进行的重拉任务（后台 SWR 与同步冷路径共用），避免多请求并发触发多次重拉
let _pendingRefresh: Promise<(PublicMoment & { isPublic: boolean })[]> | null = null;

function ensureRefreshTask(): Promise<(PublicMoment & { isPublic: boolean })[]> {
  if (!_pendingRefresh) {
    _pendingRefresh = refreshMomentsFromNotion().finally(() => {
      _pendingRefresh = null;
    });
  }
  return _pendingRefresh;
}

function triggerBackgroundRefresh(): void {
  if (_pendingRefresh) return;
  // 错误只在后台路径吞掉；同步冷路径复用同一任务时失败仍向上抛（见 notion.ts 同位置注释）
  const task = ensureRefreshTask().catch((e) => {
    console.warn("[notion-moments] background refresh failed:", e);
    return [] as (PublicMoment & { isPublic: boolean })[];
  });
  import("@vercel/functions").then(({ waitUntil }) => waitUntil(task)).catch(() => {
    // 不在 Vercel 环境：fire-and-forget
  });
}

/**
 * Fetch all moments from Notion, sorted by date descending.
 *
 * Stale-While-Revalidate（与 lib/notion.ts 同策略）：
 *  - 有缓存：立即返回旧数据。若超 NOTION_CACHE_STALE_S（5min）触发后台异步重拉。
 *  - 无缓存：同步拉。
 *
 * 注意：缓存里的 isPublic 必须保留真实值。之前为「兼容老缓存格式」无脑覆写为 true，
 * 导致 Public=false 的私密 moments 也对外公开（隐私泄露 bug）。
 */
export async function getMoments(): Promise<(PublicMoment & { isPublic: boolean })[]> {
  const cached = await getCached();
  if (cached) {
    if (isStale(cached)) {
      triggerBackgroundRefresh();
    }
    return cached.data;
  }
  return ensureRefreshTask();
}

/** Cron 预热入口：强制重拉并写缓存，返回条数。与用户请求共享 in-flight 去重。 */
export async function warmMomentsCache(): Promise<number> {
  const items = await ensureRefreshTask();
  return items.length;
}

/**
 * Paginated moments list (for /api/moments compatibility).
 */
export async function listMoments(opts: {
  limit: number;
  offset: number;
  includePrivate: boolean;
  /** 附带全部可见动态的轻量大纲（时间轴用） */
  withOutline?: boolean;
}): Promise<{ items: PublicMoment[]; total: number; hasMore: boolean; outline?: MomentOutlineItem[] }> {
  const all = await getMoments();
  // 没有图片/视频的动态（Notion 读取正文失败时会出现）前台不渲染，也不能出现在时间轴里
  const visible = all.filter((m) => (opts.includePrivate || m.isPublic) && m.media.length > 0);
  const items = visible.slice(opts.offset, opts.offset + opts.limit);
  return {
    items,
    total: visible.length,
    hasMore: opts.offset + items.length < visible.length,
    ...(opts.withOutline
      ? {
          outline: visible.map((m) => ({
            id: String(m.id),
            at: m.createdAt,
            count: m.media.length,
            ...(m.type === 2 ? { video: true as const } : {}),
          })),
        }
      : {}),
  };
}

/**
 * Flat moments format for backwards compatibility.
 */
export async function getMomentsItems(): Promise<MomentsItem[]> {
  const all = await getMoments();
  return all.map((m) => ({
    id: m.id,
    createdAt: m.createdAt,
    isPublic: m.isPublic,
    images: m.media.map((x) => x.url),
  }));
}

export function isMomentsConfigured(): boolean {
  return !!(
    process.env.NOTION_TOKEN?.trim() &&
    (process.env.NOTION_MOMENTS_DATABASE_ID ?? process.env.NOTION_GALLERY_DATABASE_ID)?.trim()
  );
}
