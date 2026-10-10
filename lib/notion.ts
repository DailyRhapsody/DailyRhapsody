/**
 * Notion CMS integration — read-only data source for diary entries.
 *
 * Replaces diaries-store.ts as the data layer. All writes happen in Notion UI;
 * the website only reads and caches.
 *
 * Required env vars:
 *   NOTION_TOKEN          – Internal integration token
 *   NOTION_DATABASE_ID    – 32-char hex ID of the diary database
 *
 * Optional:
 *   NOTION_CACHE_STALE_S  – SWR stale threshold in seconds (default 300)
 *   NOTION_CACHE_TTL      – Redis hard TTL in seconds (default 48h, floor-clamped;
 *                           this is NOT the freshness knob — see CACHE_MIN_TTL_S)
 */

import { APIResponseError, APIErrorCode, Client, RequestTimeoutError } from "@notionhq/client";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { mediaProxyPath, mediaVersion, type MediaKind } from "@/lib/notion-media";
import { assertNotionFetchAllowed, isNotionFetchAllowed, runWithRefreshLock } from "@/lib/notion-quota";
import { extractNotionDiaryDate } from "@/lib/notion-diary-date";

// ---------------------------------------------------------------------------
// Types (compatible with existing Diary interface)
// ---------------------------------------------------------------------------

export type Diary = {
  id: string; // Notion page ID (uuid)
  date: string; // YYYY-MM-DD
  publishedAt?: string; // ISO UTC
  pinned?: boolean;
  isPublic?: boolean;
  summary: string; // rich text → plain text
  /** 仅 complete 的文字正文可参与全量分析；旧缓存没有此字段。 */
  bodyStatus?: "complete" | "partial" | "stale";
  sourceEditedAt?: string;
  location?: string;
  tags?: string[];
  images?: string[]; // raw Notion file URL or external URL (max 1)
};

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
  const id = process.env.NOTION_DATABASE_ID?.trim();
  if (!id) throw new Error("NOTION_DATABASE_ID is required");
  return id;
}

// ---------------------------------------------------------------------------
// Upstash cache (optional — gracefully skips if not configured)
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

// v6：记录正文完整性与来源版本，供全量文章分析核验。
// v5 只作为展示种子；首次刷新后才能参与分析。
const CACHE_KEY = "notion:diaries:v6";
const LEGACY_CACHE_KEY = "notion:diaries:v5";
// Notion 自动化调用 /api/revalidate 时写入的时间戳：晚于快照开始时刻即视为过期。
// 单独一个小键，不回写大缓存，避免与正在进行的全量刷新互相覆盖。
// 失效信号和刷新锁继续与 v2 共享，让迁移期间的 webhook 和 Notion 限流保护仍然有效。
const INVALIDATED_KEY = "notion:diaries:v2:invalidatedAt";
// 跨实例刷新锁（lib/notion-quota.ts）。Preview 与生产共用 Upstash 也共用 NOTION_TOKEN，同一把锁正好让两边互相让路。
const REFRESH_LOCK_KEY = "notion:diaries:v2:refreshLock";
// stale-while-revalidate 阈值：缓存超过这个时间就在后台异步重拉，但仍把旧数据立即返回给用户。
// 默认 5 分钟，作者改完 Notion 最长 5min 看到新内容；Notion 自动化调 /api/revalidate 可立即触发重拉。
const CACHE_STALE_MS = (Number(process.env.NOTION_CACHE_STALE_S) || 300) * 1000;
// Redis TTL 兜底：远大于 STALE，让缓存几乎永不"消失"，只会变 stale。
// 48h：对每日一次的 Cron 预热留出一整天余量（24h 会和 Cron 周期精确撞线）。
const CACHE_HARD_TTL_S = 48 * 60 * 60;
// 硬 TTL 下限。2026-08 事故：生产把 NOTION_CACHE_TTL 配成 300，恰好等于 stale
// 阈值，SWR 彻底失效——缓存不是变 stale 而是直接消失，每 5 分钟制造一次
// 20-53s 的同步全量冷拉，前端 30s 超时后显示「暂无文章」。
// 硬 TTL 只是 SWR 的兜底网，不是新鲜度旋钮（新鲜度由 NOTION_CACHE_STALE_S 控制），
// 因此环境变量只允许加长、不允许把它压到冷窗口频发的量级。
const CACHE_MIN_TTL_S = CACHE_HARD_TTL_S;

/** refreshedAt：写入时刻，用于计龄；snapshotAt：这份快照开始抓取的时刻，用于和 invalidatedAt 比较。 */
type CacheEntry = { data: Diary[]; refreshedAt: number; snapshotAt?: number };
type CachedDiaries = CacheEntry & { invalidatedAt: number };

function cacheTtl(): number {
  // Math.floor：Redis 的 EX 只接受整数，小数会让 set 被拒、缓存永远写不进去
  const configured = Math.floor(Number(process.env.NOTION_CACHE_TTL));
  if (!Number.isFinite(configured) || configured < CACHE_MIN_TTL_S) {
    return CACHE_HARD_TTL_S;
  }
  return configured;
}

function parseEntry(data: CacheEntry | Diary[] | null): CacheEntry | null {
  if (!data) return null;
  // 兼容旧格式（直接是 Diary[]，没有 refreshedAt）
  if (Array.isArray(data)) return { data, refreshedAt: 0 };
  // 损坏数据保护：若 Redis 中的值不是 {data: Diary[], refreshedAt} 形态（比如被人手动塞了字符串/对象），
  // 直接当 cache miss 处理，让上层走回源，而不是把 undefined 透传给调用方导致 500。
  if (typeof data !== "object" || !Array.isArray(data.data)) return null;
  return data;
}

async function getCached(): Promise<CachedDiaries | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const [raw, invalidatedAt] = await redis.mget<[CacheEntry | Diary[] | null, number | null]>(
      CACHE_KEY,
      INVALIDATED_KEY
    );
    const entry = parseEntry(raw);
    if (entry) return { ...entry, invalidatedAt: Number(invalidatedAt) || 0 };
    // 新键还没写过（刚上线）：旧键数据当作已过期的种子返回，调用方会立即后台重拉
    const legacy = parseEntry(await redis.get<CacheEntry | Diary[]>(LEGACY_CACHE_KEY));
    return legacy ? { data: legacy.data, refreshedAt: 0, invalidatedAt: 0 } : null;
  } catch {
    return null;
  }
}

function isStale(cached: CachedDiaries): boolean {
  if (Date.now() - cached.refreshedAt > CACHE_STALE_MS) return true;
  return cached.invalidatedAt > (cached.snapshotAt ?? cached.refreshedAt);
}

async function setCache(diaries: Diary[], snapshotAt: number): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const entry: CacheEntry = { data: diaries, refreshedAt: Date.now(), snapshotAt };
    await redis.set(CACHE_KEY, entry, { ex: cacheTtl() });
  } catch {
    // cache write failure is non-fatal
  }
}

/**
 * Notion 自动化调用：记下过期时间并立即在后台重拉，期间访客继续看旧数据。
 * 不再删缓存——删除后首位访客要同步冷拉 80s 以上，前端 30s 超时显示「暂无文章」。
 * 别的实例正持锁刷新时，这次后台刷新拿不到锁会放弃，由持锁的那一轮收尾时补跑（refreshWithCatchUp）。
 */
export async function markDiariesCacheStale(): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(INVALIDATED_KEY, Date.now(), { ex: cacheTtl() });
  } catch {
    return;
  }
  triggerBackgroundRefresh();
}

/** 只读缓存、不触发任何重拉。供 /api/media 鉴权用，避免图片请求引发全量抓取。 */
export async function getCachedDiaries(): Promise<Diary[] | null> {
  return (await getCached())?.data ?? null;
}

/** 全量分析不能用失效快照或抓取不全的正文。刷新仍走现有锁和预算。 */
export class IncompleteAnalysisSourceError extends Error {
  readonly count: number;
  constructor(count: number) { super("存在无法完整读取的文字正文"); this.count = count; }
}

export async function getAnalysisDiaries(): Promise<Diary[] | null> {
  const cached = await getCached();
  if (!cached || isStale(cached)) {
    triggerBackgroundRefresh();
    return null;
  }
  const articles = cached.data.filter((d) => d.isPublic !== false);
  const partial = articles.filter((d) => d.bodyStatus === "partial").length;
  if (partial) throw new IncompleteAnalysisSourceError(partial);
  if (articles.some((d) => d.bodyStatus !== "complete")) {
    triggerBackgroundRefresh();
    return null;
  }
  return articles;
}

// ---------------------------------------------------------------------------
// Notion property helpers
// ---------------------------------------------------------------------------

function richTextToPlain(items: RichTextItemResponse[]): string {
  return items.map((i) => i.plain_text).join("");
}

/**
 * 终端输出的 box-drawing 表格（CLI 里 ┌─┬─┐ 画出来的那种）被粘进 Notion 后是
 * 普通 paragraph。这类文本含上百个连续 ─ 且中间无空格，浏览器找不到断行点，
 * 会把正文容器整个撑破（「AGV产业思考」一文即如此，横向溢出到页面外）。
 *
 * 它本质是预格式化文本，包成代码块交给 <pre> 渲染：等宽对齐得以保留，超宽部分
 * 由 PROSE class 里的 [&_pre]:overflow-x-auto 变成块内横向滚动，不再溢出正文。
 */
const TERMINAL_ART_RE = /[┌┐└┘├┤┬┴┼╭╮╰╯]|[─━]{3,}/;

/**
 * 围栏用比正文里最长一串反引号再多一个的反引号，避免代码块被提前闭合。
 * 渲染侧切分代码块的正则（lib/markdown.ts、lib/editor-hashtag-highlight.ts）按同样规则配对。
 */
function codeFence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function asCodeFence(text: string): string {
  const fence = codeFence(text);
  return `${fence}\n${text}\n${fence}`;
}

function richTextToMarkdown(items: RichTextItemResponse[]): string {
  return items
    .map((i) => {
      let t = i.plain_text;
      const a = i.annotations;
      if (a.code) t = `\`${t}\``;
      if (a.bold) t = `**${t}**`;
      if (a.italic) t = `*${t}*`;
      if (a.strikethrough) t = `~~${t}~~`;
      if (i.href) t = `[${t}](${i.href})`;
      return t;
    })
    .join("");
}

/**
 * proxyMedia：Notion 托管的图片 / 视频输出站内代理路径（见 lib/notion-media.ts）。
 * deadline：重试预算的截止时刻（见 withNotionRetry）。
 */
type BodyOptions = {
  proxyMedia: boolean;
  deadline: number;
  pageTitle?: string;
  completeness?: { partial: boolean };
};

function notionFileUrl(
  f: { type: "file"; file: { url: string } } | { type: "external"; external: { url: string } } | { type: string },
  blockId: string,
  opts: BodyOptions
): string {
  if (f.type === "file" && "file" in f) {
    return opts.proxyMedia ? mediaProxyPath("b", blockId, f.file.url) : f.file.url;
  }
  if (f.type === "external" && "external" in f) return f.external.url;
  return "";
}

function blockToMarkdown(b: BlockObjectResponse, opts: BodyOptions): string {
  switch (b.type) {
    case "paragraph": {
      const plain = richTextToPlain(b.paragraph.rich_text);
      // 用纯文本包围栏：加粗/链接等 markdown 标记在 <pre> 里会显示成字面量
      if (TERMINAL_ART_RE.test(plain)) return asCodeFence(plain);
      return richTextToMarkdown(b.paragraph.rich_text);
    }
    case "heading_1":
      return `# ${richTextToMarkdown(b.heading_1.rich_text)}`;
    case "heading_2":
      return `## ${richTextToMarkdown(b.heading_2.rich_text)}`;
    case "heading_3":
      return `### ${richTextToMarkdown(b.heading_3.rich_text)}`;
    case "bulleted_list_item":
      return `- ${richTextToMarkdown(b.bulleted_list_item.rich_text)}`;
    case "numbered_list_item":
      return `1. ${richTextToMarkdown(b.numbered_list_item.rich_text)}`;
    case "quote":
      return `> ${richTextToMarkdown(b.quote.rich_text)}`;
    case "to_do":
      return `- [${b.to_do.checked ? "x" : " "}] ${richTextToMarkdown(b.to_do.rich_text)}`;
    case "code": {
      const lang = b.code.language === "plain text" ? "" : b.code.language;
      // 代码块内容按纯文本输出：加粗 / 链接的 markdown 标记在 <pre> 里会变成字面量，
      // mermaid 源码也会被写坏
      const text = richTextToPlain(b.code.rich_text);
      const fence = codeFence(text);
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case "equation":
      return `$$${b.equation.expression}$$`;
    case "child_page":
      return b.child_page.title;
    case "child_database":
      return b.child_database.title;
    case "callout":
      return `> ${richTextToMarkdown(b.callout.rich_text)}`;
    case "divider":
      return "---";
    case "image": {
      const url = notionFileUrl(b.image, b.id, opts);
      return url ? `![](${url})` : "";
    }
    case "video": {
      const url = notionFileUrl(b.video, b.id, opts);
      return url ? `![](${url})` : "";
    }
    case "bookmark":
      return b.bookmark.url ? `[${b.bookmark.url}](${b.bookmark.url})` : "";
    case "embed":
      return b.embed.url ? `[${b.embed.url}](${b.embed.url})` : "";
    case "toggle":
      // 折叠块：标题作为段落输出，子内容由 walkBlocks 递归追加在后面
      return richTextToMarkdown(b.toggle.rich_text);
    case "synced_block":
    case "column_list":
    case "column":
      // 容器型 block 自身没有内容，子节点会被 walkBlocks 递归输出
      return "";
    default:
      return "";
  }
}

// Notion 平均限速约 3 req/s（按 token 计，跨实例共享），全量刷新要逐篇拉 281 篇正文，
// 必然撞上 429。SDK 2.3.0 不重试，异常又被吞掉、正文回退成标题并写进缓存：
// 2026-09 线上缓存 281 篇里有 110 篇只剩标题。这里按 Retry-After 等待后重试，
// 加随机抖动，避免多个 worker 读到同一个 Retry-After 后同时醒来再次撞限。
// 连接被重置、请求超时、Notion 5xx 这类瞬时故障同样重试（实测全量刷新偶发 ECONNRESET）。
const NOTION_MAX_RETRIES = 6;
// 重试总预算：等待不能越过调用方给的截止时刻。2026-09-18 线上 Retry-After 从 8s 涨到 53s，
// 照单全收时单个调用最多卡 5 分钟，全量刷新会被 maxDuration 截断、整轮白跑。
//  - 全量刷新 200s：各路由 maxDuration=300s，扣掉 SDK 单请求 60s 超时后仍能写进缓存
//  - 用户请求路径（详情页）15s：前端 30s 超时
//  - 媒体代理 3s：限流时立即回 503，不让图片请求干等
const REFRESH_BUDGET_MS = 200_000;
const REQUEST_BUDGET_MS = 15_000;
const MEDIA_BUDGET_MS = 3_000;
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_SOCKET"]);

function retryDelayMs(e: unknown, attempt: number): number | null {
  if (APIResponseError.isAPIResponseError(e)) {
    if (e.code === APIErrorCode.RateLimited) {
      const headers = e.headers as { get?: (name: string) => string | null } | undefined;
      const retryAfterS = Number(headers?.get?.("retry-after"));
      return Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : 1000 * 2 ** attempt;
    }
    if (e.code === APIErrorCode.InternalServerError || e.code === APIErrorCode.ServiceUnavailable) {
      return 1000 * 2 ** attempt;
    }
    return null;
  }
  if (RequestTimeoutError.isRequestTimeoutError(e)) return 1000 * 2 ** attempt;
  const code = (e as { code?: unknown } | null)?.code;
  const status = (e as { status?: unknown } | null)?.status;
  const headers = (e as { headers?: { get?: (name: string) => string | null } } | null)?.headers;
  if (code === "rate_limited" || status === 429) {
    const retryAfterS = Number(headers?.get?.("retry-after"));
    return Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : 1000 * 2 ** attempt;
  }
  if (code === "internal_server_error" || code === "service_unavailable" || status === 500 || status === 503) {
    return 1000 * 2 ** attempt;
  }
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return 1000 * 2 ** attempt;
  return null;
}

async function withNotionRetry<T>(call: () => Promise<T>, deadline: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    // 预算用完不再发起新请求；重试等完才超时的，抛回上一次的错误（限流仍按限流处理，媒体代理回 503）
    if (Date.now() >= deadline) throw lastError ?? new Error("Notion request budget exhausted");
    try {
      return await call();
    } catch (e) {
      lastError = e;
      const delayMs = attempt < NOTION_MAX_RETRIES ? retryDelayMs(e, attempt) : null;
      if (delayMs === null) throw e;
      const waitMs = delayMs + Math.random() * 1000;
      // 等完就过了截止时刻：放弃重试，原错误交给调用方（正文沿用上一版、媒体代理回 503）
      if (Date.now() + waitMs > deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

type NotionApiList<T> = {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
};

type NotionDatabaseContainer = {
  data_sources?: Array<{ id: string; name?: string }>;
};

type NotionDataSource = {
  properties?: Record<string, { type?: string }>;
};

type NotionDataSourceSearchResult = {
  object?: string;
  id?: string;
  title?: Array<{ plain_text?: string }>;
};

/**
 * 2025-09-03 起 Notion 把 database 容器和 data source 拆开；旧版 SDK 还没有
 * dataSources endpoint，因此嵌入式数据库走这里，Blog/Moments 旧库仍走 SDK 兼容路径。
 */
async function notionApiJson<T>(
  path: string,
  init: RequestInit,
  deadline: number
): Promise<T> {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) throw new Error("NOTION_TOKEN is required");
  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!response.ok) {
    const error = new Error(`Notion API ${response.status}: ${body.code ?? body.message ?? "request failed"}`) as Error & {
      code?: string;
      status?: number;
      headers?: Headers;
    };
    error.code = body.code;
    error.status = response.status;
    error.headers = response.headers;
    throw error;
  }
  return body as T;
}

function escapeTableCell(text: string): string {
  // GFM 只要求转义 |（行内代码里的 \| 也会被还原）；反斜杠不加倍，否则行内代码里会多出一个
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

type NotionDatabaseProperty = PageObjectResponse["properties"][string];

function formatNotionDateTime(value: string): string {
  if (!value.includes("T")) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function formatDateProperty(date: { start?: string | null; end?: string | null } | null): string {
  if (!date?.start) return "";
  const start = formatNotionDateTime(date.start);
  const end = date.end && date.end !== date.start ? formatNotionDateTime(date.end) : "";
  return end ? `${start} – ${end}` : start;
}

function notionPersonName(person: unknown): string {
  if (!person || typeof person !== "object") return "";
  const value = person as { name?: string | null; person?: { email?: string | null } | null };
  return value.name ?? value.person?.email ?? "";
}

/** 数据库行属性 → Markdown 单元格。数据库行本质上是另一个 page，需要先压平属性。 */
function databasePropertyToMarkdown(
  property: NotionDatabaseProperty | undefined,
  pageId: string,
  opts: BodyOptions
): string {
  if (!property) return "";
  switch (property.type) {
    case "title":
      return richTextToMarkdown(property.title);
    case "rich_text":
      return richTextToMarkdown(property.rich_text);
    case "number":
      return property.number == null ? "" : String(property.number);
    case "url":
      return property.url ? `[${property.url}](${property.url})` : "";
    case "email":
      return property.email ? `[${property.email}](mailto:${property.email})` : "";
    case "phone_number":
      return property.phone_number ?? "";
    case "select":
      return property.select?.name ?? "";
    case "status":
      return property.status?.name ?? "";
    case "multi_select":
      return property.multi_select.map((item) => item.name).join(", ");
    case "date":
      return formatDateProperty(property.date);
    case "checkbox":
      return property.checkbox ? "✓" : "";
    case "files":
      return property.files
        .map((file) => {
          if ("file" in file) {
            const url = opts.proxyMedia
              ? mediaProxyPath("p", pageId, file.file.url)
              : file.file.url;
            return `![${file.name}](${url})`;
          }
          if ("external" in file) return `![${file.name}](${file.external.url})`;
          return "";
        })
        .filter(Boolean)
        .join("<br>");
    case "created_time":
      return formatNotionDateTime(property.created_time);
    case "last_edited_time":
      return formatNotionDateTime(property.last_edited_time);
    case "created_by":
      return notionPersonName(property.created_by);
    case "last_edited_by":
      return notionPersonName(property.last_edited_by);
    case "people":
      return property.people.map(notionPersonName).filter(Boolean).join(", ");
    case "relation":
      return property.relation.map((item) => item.id).join(", ");
    case "unique_id":
      return property.unique_id.number == null
        ? ""
        : `${property.unique_id.prefix ?? ""}${property.unique_id.number}`;
    case "formula": {
      const formula = property.formula;
      if (formula.type === "string") return formula.string ?? "";
      if (formula.type === "number") return formula.number == null ? "" : String(formula.number);
      if (formula.type === "boolean") return formula.boolean ? "✓" : "";
      if (formula.type === "date") return formatDateProperty(formula.date);
      return "";
    }
    case "rollup": {
      const rollup = property.rollup;
      if (rollup.type === "number") return rollup.number == null ? "" : String(rollup.number);
      if (rollup.type === "date") return formatDateProperty(rollup.date);
      return "";
    }
    default:
      return "";
  }
}

type EmbeddedDatabaseData = {
  columns: string[];
  propertyTypes: Record<string, string>;
  pages: PageObjectResponse[];
};

async function queryEmbeddedDatabaseWithDataSource(
  databaseId: string,
  deadline: number
): Promise<EmbeddedDatabaseData | null> {
  const database = await notionApiJson<NotionDatabaseContainer>(
    `databases/${databaseId}`,
    { method: "GET" },
    deadline
  );
  const dataSourceId = database.data_sources?.[0]?.id;
  if (!dataSourceId) return null;

  return queryDataSource(dataSourceId, deadline);
}

async function queryDataSource(
  dataSourceId: string,
  deadline: number
): Promise<EmbeddedDatabaseData> {

  const dataSource = await notionApiJson<NotionDataSource>(
    `data_sources/${dataSourceId}`,
    { method: "GET" },
    deadline
  );
  const columns = Object.keys(dataSource.properties ?? {});
  const propertyTypes = Object.fromEntries(
    Object.entries(dataSource.properties ?? {}).map(([name, property]) => [name, property.type ?? ""])
  );
  if (columns.length === 0) return { columns, propertyTypes, pages: [] };

  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response = await notionApiJson<NotionApiList<PageObjectResponse>>(
      `data_sources/${dataSourceId}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(cursor ? { start_cursor: cursor } : {}),
          page_size: 100,
        }),
      },
      deadline
    );
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return { columns, propertyTypes, pages };
}

/**
 * Notion 的 linked database 视图只返回一个没有 data source 的 child_database block。
 * 当前页面标题与原始数据源标题一致时，用标题搜索并读取原始数据源。
 */
async function queryLinkedDatabaseByTitle(
  pageTitle: string | undefined,
  deadline: number
): Promise<EmbeddedDatabaseData | null> {
  const title = pageTitle?.trim();
  if (!title) return null;

  const response = await notionApiJson<{ results: NotionDataSourceSearchResult[] }>(
    "search",
    {
      method: "POST",
      body: JSON.stringify({ query: title, page_size: 100 }),
    },
    deadline
  );
  const source = response.results.find(
    (result) =>
      result.object === "data_source" &&
      result.id &&
      result.title?.map((item) => item.plain_text ?? "").join("") === title
  );
  return source?.id ? queryDataSource(source.id, deadline) : null;
}

async function queryEmbeddedDatabaseLegacy(
  databaseId: string,
  deadline: number
): Promise<EmbeddedDatabaseData> {
  const database = await withNotionRetry(
    () => getClient().databases.retrieve({ database_id: databaseId }),
    deadline
  );
  if (!("properties" in database)) return { columns: [], propertyTypes: {}, pages: [] };

  const columns = Object.keys(database.properties);
  const propertyTypes = Object.fromEntries(
    Object.entries(database.properties).map(([name, property]) => [
      name,
      "type" in property && typeof property.type === "string" ? property.type : "",
    ])
  );
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response = await withNotionRetry(
      () => getClient().databases.query({ database_id: databaseId, start_cursor: cursor, page_size: 100 }),
      deadline
    );
    for (const page of response.results) {
      if ("properties" in page) pages.push(page as PageObjectResponse);
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return { columns, propertyTypes, pages };
}

/**
 * Notion 的嵌入式数据库（child_database）→ GFM 表格。
 * `database_id` 在 child_database block 上就是数据库 ID；行则通过 query 返回为 page。
 */
async function databaseToMarkdown(
  databaseId: string,
  deadline: number,
  opts: BodyOptions
): Promise<string> {
  try {
    let data: EmbeddedDatabaseData | null = null;
    try {
      data = await withNotionRetry(
        () => queryEmbeddedDatabaseWithDataSource(databaseId, deadline),
        deadline
      );
    } catch {
      // 旧 workspace / 旧 database 仍可能只暴露 2022-06-28 的 SDK 接口。
    }
    if (!data) {
      try {
        data = await queryEmbeddedDatabaseLegacy(databaseId, deadline);
      } catch {
        // linked database 的视图容器本身通常无法通过旧接口读取，继续尝试原始数据源。
      }
    }
    if (!data && opts.pageTitle) {
      try {
        data = await queryLinkedDatabaseByTitle(opts.pageTitle, deadline);
      } catch {
        // 搜索不到对应原始数据源时，保留正文其余内容。
      }
    }
    if (!data || data.columns.length === 0) return "";

    const { columns, propertyTypes, pages } = data;
    const orderedColumns = [...columns].sort((a, b) => {
      const rank = (column: string) => {
        const type = propertyTypes[column];
        if (type === "title") return 0;
        if (type === "multi_select" || type === "select" || type === "status") return 1;
        if (type === "date" || type === "created_time" || type === "last_edited_time") return 2;
        return 3;
      };
      return rank(a) - rank(b);
    });
    const line = (cells: string[]) =>
      `| ${orderedColumns.map((column, index) => cells[index] ?? "").join(" | ")} |`;
    const header = line(orderedColumns.map(escapeTableCell));
    const divider = line(orderedColumns.map(() => "---"));
    const rows = pages.map((page) =>
      line(orderedColumns.map((column) =>
        escapeTableCell(databasePropertyToMarkdown(page.properties[column], page.id, opts))
      ))
    );
    return [header, divider, ...rows].join("\n");
  } catch (e) {
    // 子数据库没有单独连接给 integration 时，正文的其余内容仍应正常显示。
    console.warn(`[notion] embedded database ${databaseId} unavailable:`, e);
    return "";
  }
}

/**
 * Notion 表格 → GFM 表格。行是 table 的子 block（table_row），这里一次拉完拼成整段，
 * 调用方跳过通用递归，避免逐行重复输出。GFM 必须有表头：没有列标题时补一行空表头。
 */
async function tableToMarkdown(
  table: Extract<BlockObjectResponse, { type: "table" }>,
  deadline: number
): Promise<string> {
  const rows: string[][] = [];
  let cursor: string | undefined;
  do {
    const r = await withNotionRetry(
      () => getClient().blocks.children.list({ block_id: table.id, start_cursor: cursor, page_size: 100 }),
      deadline
    );
    for (const b of r.results) {
      if (!("type" in b) || b.type !== "table_row") continue;
      rows.push(b.table_row.cells.map((cell) => escapeTableCell(richTextToMarkdown(cell))));
    }
    cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
  } while (cursor);
  if (rows.length === 0) return "";

  const width = Math.max(table.table.table_width, ...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const header = table.table.has_column_header ? rows.shift() ?? [] : [];
  const body = table.table.has_row_header
    ? rows.map((row) => row.map((cell, i) => (i === 0 && cell ? `**${cell}**` : cell)))
    : rows;
  return [line(header), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

/**
 * 递归遍历 page 下的所有 block，处理 toggle / column_list / synced_block 等容器。
 * Notion API 对每个有 has_children 的 block 都需要再调一次 list；这里限制深度避免循环。
 */
async function walkBlocks(
  blockId: string,
  depth: number,
  parts: string[],
  opts: BodyOptions,
  maxDepth = opts.completeness ? 32 : 3
): Promise<void> {
  if (depth > maxDepth) {
    if (opts.completeness) opts.completeness.partial = true;
    return;
  }
  let cursor: string | undefined;
  do {
    const r = await withNotionRetry(
      () =>
        getClient().blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100,
        }),
      opts.deadline
    );
    for (const b of r.results) {
      if (!("type" in b)) {
        if (opts.completeness) opts.completeness.partial = true;
        continue;
      }
      const block = b as BlockObjectResponse;
      if (block.type === "table") {
        const table = await tableToMarkdown(block, opts.deadline);
        if (table) parts.push(table);
        continue;
      }
      if (block.type === "child_database") {
        const table = await databaseToMarkdown(
          block.id,
          opts.deadline,
          opts
        );
        if (table) parts.push(table);
        continue;
      }
      if (block.type === "callout" || block.type === "quote") {
        const content = [richTextToMarkdown(block.type === "callout" ? block.callout.rich_text : block.quote.rich_text)];
        if (block.has_children) {
          await walkBlocks(block.id, depth + 1, content, opts, maxDepth);
        }
        if (block.type === "callout") {
          const icon = block.callout.icon;
          const emoji = icon?.type === "emoji" ? icon.emoji : "💡";
          content.unshift(`[!NOTION-CALLOUT] ${emoji}\n`);
        }
        parts.push(content.join("\n\n").split("\n").map((line) => `> ${line}`).join("\n"));
        continue;
      }
      const md = blockToMarkdown(block, opts);
      // 未支持的文字块不能静默认证为全文；图片/视频本身不在文字分析范围。
      if (opts.completeness && block.type === "unsupported") {
        opts.completeness.partial = true;
      }
      if (md) parts.push(md);
      if (block.has_children) {
        await walkBlocks(block.id, depth + 1, parts, opts, maxDepth);
      }
    }
    cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
  } while (cursor);
}

/** 抓取失败返回 null，让全量刷新能区分「正文确实为空」和「这次没抓到」。 */
async function tryExtractBodyMarkdown(
  pageId: string,
  opts: BodyOptions
): Promise<string | null> {
  const parts: string[] = [];
  try {
    await walkBlocks(pageId, 0, parts, opts);
  } catch (e) {
    console.warn(`[notion] extractBodyMarkdown failed for ${pageId}:`, e);
    return null;
  }
  return parts.join("\n\n");
}

/**
 * 页面正文 → markdown。日记传 proxyMedia: true；Reference 等没有接入媒体代理鉴权的
 * 数据源保持默认，图片仍输出 Notion 原始地址。不传 deadline 时按用户请求路径的预算。
 * 返回 null 表示这次没抓到（限流、预算用完等），调用方不要把它当空正文缓存下来。
 */
export async function extractBodyMarkdown(
  pageId: string,
  opts: Partial<BodyOptions> = {}
): Promise<string | null> {
  return tryExtractBodyMarkdown(pageId, {
    proxyMedia: opts.proxyMedia ?? false,
    deadline: opts.deadline ?? Date.now() + REQUEST_BUDGET_MS,
  });
}

/**
 * 到截止时刻就不再领新页面：没抓的正文不进结果，由调用方沿用上一版缓存。
 * 页面按日期倒序排列，最新（最可能刚改过）的先抓。
 */
async function extractBodyMarkdownBatch(
  pages: PageObjectResponse[],
  deadline: number,
  concurrency = 3
): Promise<Map<string, { text: string; complete: boolean } | null>> {
  const out = new Map<string, { text: string; complete: boolean } | null>();
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (idx < pages.length && Date.now() < deadline) {
      const i = idx++;
      const page = pages[i];
      // completeness 记录这轮正文是否被截断（深度上限 / 未支持的 block），
      // 供上层区分「正文确实完整」与「只抓到一部分」，不要把残缺正文写成完整快照。
      const completeness = { partial: false };
      const text = await tryExtractBodyMarkdown(page.id, {
        proxyMedia: true,
        deadline,
        pageTitle: extractTitle(page),
        completeness,
      });
      out.set(page.id, text === null ? null : { text, complete: !completeness.partial });
    }
  });
  await Promise.all(workers);
  const skipped = pages.length - out.size;
  const failed = [...out.values()].filter((body) => body === null).length;
  if (skipped + failed > 0) {
    console.warn(
      `[notion] ${skipped + failed}/${pages.length} bodies kept from previous snapshot ` +
        `(${skipped} not started before deadline, ${failed} failed)`
    );
  }
  return out;
}

function extractTitle(page: PageObjectResponse): string {
  // Notion databases always have a Title property
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop.type === "title") {
      return richTextToPlain(prop.title);
    }
  }
  return "";
}

type PlaceValue = { name?: string | null; address?: string | null } | null;

function extractLocation(page: PageObjectResponse): string | undefined {
  const prop = page.properties["Location"];
  if (prop?.type === "rich_text") {
    const text = richTextToPlain(prop.rich_text);
    return text || undefined;
  }
  // Notion 里 Location 已改成「地点」(place) 类型，之前只认 rich_text，全站地点都读不出。
  // @notionhq/client 2.3.0 的类型定义没有 place，只能断言；只取地名，
  // 经纬度和 place id 不进 API 响应。
  const raw = prop as unknown as { type?: string; place?: PlaceValue } | undefined;
  if (raw?.type === "place") {
    return raw.place?.name?.trim() || raw.place?.address?.trim() || undefined;
  }
  return undefined;
}

function extractTags(page: PageObjectResponse): string[] {
  const prop = page.properties["Tags"];
  if (prop?.type === "multi_select") {
    return prop.multi_select.map((t) => t.name);
  }
  return [];
}

function extractPinned(page: PageObjectResponse): boolean {
  // pin 为当前字段；仅缺失时兼容旧字段，取消勾选必须覆盖旧值。
  const prop = page.properties["pin"] ?? page.properties["Pinned"];
  if (prop?.type === "checkbox") {
    return prop.checkbox;
  }
  return false;
}

function extractIsPublic(page: PageObjectResponse): boolean {
  const prop = page.properties["Public"];
  if (prop?.type === "checkbox") {
    return prop.checkbox;
  }
  // Default to public if property doesn't exist
  return true;
}

// ---------------------------------------------------------------------------
// Image extraction from the "Image" Files property (max 1 image per entry)
// ---------------------------------------------------------------------------

function extractImages(page: PageObjectResponse): string[] {
  const prop = page.properties["Image"];
  if (prop?.type !== "files") return [];
  const first = prop.files[0];
  if (!first) return [];
  let url: string | undefined;
  if (first.type === "file") {
    url = mediaProxyPath("p", page.id, first.file.url);
  } else if (first.type === "external") {
    url = first.external.url;
  }
  return url ? [url] : [];
}

// ---------------------------------------------------------------------------
// Core: fetch all diaries from Notion
// ---------------------------------------------------------------------------

function mapPageToDiary(page: PageObjectResponse, bodyMarkdown: string): Diary {
  const title = extractTitle(page);

  return {
    id: page.id,
    ...extractNotionDiaryDate(page),
    pinned: extractPinned(page),
    isPublic: extractIsPublic(page),
    summary: bodyMarkdown || title,
    location: extractLocation(page),
    tags: extractTags(page),
    images: extractImages(page),
  };
}

// 正在进行的重拉任务（后台 SWR 与同步冷路径共用），避免多请求并发触发多次重拉。
// 之前只有后台路径去重：N 个并发冷请求会跑 N 份完整抓取并互相争抢 Notion
// 速率配额，实测把单份 22s 拖到 53s。跨实例去重由 Redis 锁负责（runWithRefreshLock）。
let _pendingRefresh: Promise<Diary[] | null> | null = null;

/**
 * 取得本实例当前的重拉任务；没有就启动一份。所有调用方共享同一个 Promise。
 * 返回 null：后台刷新没拿到跨实例锁（别的实例在跑，或上一轮失败仍在冷却期）。force 的任务不会返回 null。
 */
function ensureRefreshTask(force: boolean): Promise<Diary[] | null> {
  if (!_pendingRefresh) {
    _pendingRefresh = getRedis()
      .then((redis) => {
        // 配置缺失这类必然失败的错误在拿锁前抛出，不给共享的锁写冷却期
        getClient();
        getDatabaseId();
        return runWithRefreshLock(redis, REFRESH_LOCK_KEY, force, refreshWithCatchUp);
      })
      .finally(() => {
        _pendingRefresh = null;
      });
  }
  return _pendingRefresh;
}

/** 同步路径（冷启动、Cron）一定要拿到数据：碰上本实例一份没拿到锁的后台任务（很快返回 null），等它结束再强制刷新。 */
async function refreshNow(): Promise<Diary[]> {
  for (;;) {
    const diaries = await ensureRefreshTask(true);
    if (diaries !== null) return diaries;
  }
}

// 持锁补跑的截止时刻（从本轮开始计）与最少剩余时间。截止时刻只挡新请求，已发出的请求最长还要等
// SDK 超时 60s：230s + 60s 仍在锁 TTL 与各路由 maxDuration（均 300s）之内
const CATCH_UP_DEADLINE_MS = 230_000;
const CATCH_UP_MIN_REMAINING_MS = 60_000;

async function invalidatedAfter(ts: number): Promise<boolean> {
  const redis = await getRedis();
  if (!redis) return false;
  try {
    return (Number(await redis.get(INVALIDATED_KEY)) || 0) > ts;
  } catch {
    return false;
  }
}

/**
 * 刷新途中 Notion 自动化又调了 /api/revalidate：那次后台刷新因为锁被占而放弃，这一轮的快照又早于修改。
 * 趁锁还在手里补跑一轮，否则这次修改要等下一位访客触发刷新才上线。剩余时间不够就不补，交给下一次访问。
 */
async function refreshWithCatchUp(holdsLock: boolean): Promise<Diary[]> {
  const startedAt = Date.now();
  const diaries = await refreshDiariesFromNotion(startedAt + REFRESH_BUDGET_MS);
  // 没拿到锁的强制刷新（冷启动、Cron）不补，由持锁的实例补，避免两边各多跑一轮
  if (!holdsLock) return diaries;
  const catchUpDeadline = startedAt + CATCH_UP_DEADLINE_MS;
  if (Date.now() > catchUpDeadline - CATCH_UP_MIN_REMAINING_MS) return diaries;
  if (!(await invalidatedAfter(startedAt))) return diaries;
  try {
    return await refreshDiariesFromNotion(catchUpDeadline);
  } catch (e) {
    // 补跑失败不能连累第一轮已写入的结果；缓存快照仍早于修改、判为过期，下一次访问会再拉
    console.warn("[notion] catch-up refresh failed, keeping first pass:", e);
    return diaries;
  }
}

async function refreshDiariesFromNotion(deadline: number): Promise<Diary[]> {
  const client = getClient();
  const databaseId = getDatabaseId();
  const snapshotAt = Date.now();
  // 上一版缓存：既用来跳过没改过且已是完整快照的正文，也用来在限流/超预算时沿用旧正文。
  const previous = new Map((await getCached())?.data.map((d) => [d.id, d]) ?? []);

  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response = await withNotionRetry(
      () =>
        client.databases.query({
          database_id: databaseId,
          start_cursor: cursor,
          page_size: 100,
          sorts: [{ property: "Date", direction: "descending" }],
        }),
      deadline
    );
    for (const page of response.results) {
      if ("properties" in page) {
        pages.push(page as PageObjectResponse);
      }
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  // 正文没被改过、上一版已是完整快照的页面不再重抓，省下 Notion 限流额度。
  const reusable = (page: PageObjectResponse) => {
    const old = previous.get(page.id);
    return !!page.last_edited_time && old?.bodyStatus === "complete" && old.sourceEditedAt === page.last_edited_time;
  };
  const bodies = await extractBodyMarkdownBatch(pages.filter((p) => !reusable(p)), deadline);
  // 重试用尽或预算用完仍没抓到的正文沿用上一版缓存，不让一次限流把好数据覆盖成只剩标题
  const diaries = pages.map((page) => {
    const body = bodies.get(page.id);
    const old = previous.get(page.id);
    return {
      ...mapPageToDiary(page, body?.text ?? old?.summary ?? ""),
      sourceEditedAt: page.last_edited_time,
      bodyStatus: reusable(page) || body?.complete ? "complete" as const : body ? "partial" as const : "stale" as const,
    };
  });

  const createdTimes = new Map(pages.map((page) => [page.id, Date.parse(page.created_time)]));
  // 置顶组按页面创建时间倒序；普通文章保持既有 Date 排序。
  diaries.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if (a.pinned && b.pinned) return createdTimes.get(b.id)! - createdTimes.get(a.id)!;
    return (
      new Date(b.publishedAt ?? b.date).getTime() -
      new Date(a.publishedAt ?? a.date).getTime()
    );
  });

  await setCache(diaries, snapshotAt);
  return diaries;
}

function triggerBackgroundRefresh(): void {
  if (_pendingRefresh) return; // 已有任务在跑，避免堆叠
  // 本地开发没放行回源时不发起后台刷新，继续用缓存里现有的数据
  if (!isNotionFetchAllowed()) return;
  // 后台路径吞掉错误（用户继续看旧数据）；catch 产生的新 Promise 不写回
  // _pendingRefresh，同步冷路径复用同一任务时失败仍会向上抛（route 返回 500，
  // 而不是拿到 [] 渲染成「暂无文章」）。
  const task = ensureRefreshTask(false).catch((e) => {
    console.warn("[notion] background refresh failed:", e);
    return [] as Diary[];
  });
  // Vercel serverless function 在响应返回后会冻结实例，导致后台 Promise 被中断。
  // 用 waitUntil 让 runtime 等任务完成（不延长用户响应时间）。
  // 动态 import 避免在没有 @vercel/functions 的环境（如本地 dev）报错。
  import("@vercel/functions").then(({ waitUntil }) => waitUntil(task)).catch(() => {
    // 不在 Vercel 环境（本地 / 测试）：fire-and-forget，进程不结束就能跑完
  });
}

/**
 * Fetch all diary entries: pinned first by creation time, then normal entries by Date, both descending.
 *
 * Stale-While-Revalidate 策略：
 *  - 有缓存：立即返回旧数据（≤1s）。若超过 NOTION_CACHE_STALE_S（默认 5min）触发后台异步重拉。
 *  - 无缓存（首次冷启动）：同步拉取（~18s），完成后缓存供后续使用。
 *  - 后台重拉失败不影响读取（用户继续看到旧数据，下次再试）。
 *
 * 用户改 Notion 后：
 *  - 默认最长 NOTION_CACHE_STALE_S 后看到新内容
 *  - Notion 自动化调 /api/revalidate：标记过期并立即后台重拉（约 2 分钟后生效；已有一轮在跑时顺延到它补跑完）
 */
export async function getDiaries(): Promise<Diary[]> {
  const cached = await getCached();
  if (cached) {
    if (isStale(cached)) {
      // 数据过期但仍可用：后台异步刷新，立即返回旧数据
      triggerBackgroundRefresh();
    }
    return cached.data;
  }
  // 完全无缓存：同步拉（复用 in-flight 任务，并发冷请求只跑一份抓取）
  return refreshNow();
}

/**
 * Cron 预热入口：无视 stale 阈值强制重拉并写缓存，返回条数。
 * 与用户请求共享 in-flight 去重。
 */
export async function warmDiariesCache(): Promise<number> {
  const diaries = await refreshNow();
  return diaries.length;
}

/**
 * Fetch a single diary entry by Notion page ID.
 */
export async function getDiaryById(id: string): Promise<Diary | null> {
  // Try to find in cache first
  const cached = await getCached();
  if (cached) {
    // 与列表同一套 SWR：过期就后台重拉，Notion 里的删除/私密不会卡在详情缓存里
    if (isStale(cached)) triggerBackgroundRefresh();
    const found = cached.data.find((d) => d.id === id);
    if (found) return found;
  }

  try {
    const client = getClient();
    const deadline = Date.now() + REQUEST_BUDGET_MS;
    const page = await withNotionRetry(() => client.pages.retrieve({ page_id: id }), deadline);

    if (!("properties" in page)) return null;
    // Notion 是唯一后台：在 Notion 删除（进回收站）的页、不属于日记库的页，前端一律当不存在。
    // pages.retrieve 对回收站里的页照样返回 200，不拦就能按 id 读到已删文章。
    const full = page as PageObjectResponse & { in_trash?: boolean };
    if (full.archived || full.in_trash) return null;
    const parentDb =
      full.parent.type === "database_id" ? full.parent.database_id.replace(/-/g, "") : "";
    if (parentDb !== getDatabaseId().replace(/-/g, "")) return null;

    const body = await extractBodyMarkdown(id, {
      proxyMedia: true,
      deadline,
      pageTitle: extractTitle(page as PageObjectResponse),
    });
    return mapPageToDiary(page as PageObjectResponse, body ?? "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Media proxy support（/api/media 用）
// ---------------------------------------------------------------------------

export type NotionFileRef = { url: string; media: "image" | "video"; fromCache: boolean };

// 签名地址缓存到过期前 15 分钟：视频 302 跳转后浏览器还要分段取数据，得留出播放时间
const SIGNED_URL_SAFETY_S = 15 * 60;

/**
 * 取 Notion 托管文件当前有效的签名地址，且文件版本必须与请求路径里的 v 一致
 * （换图后旧版本路径不会拿到新图，新版本路径也不会命中旧签名）。
 * 签名地址在 Redis 里按 kind:id:v 缓存，有效期内不重复调 Notion。调用方负责先确认该文件属于公开内容。
 * 返回 "rate-limited"：Notion 限流且等不起（MEDIA_BUDGET_MS），调用方应回 503 而不是 404。
 */
export async function resolveNotionFileUrl(
  kind: MediaKind,
  id: string,
  v: string,
  opts: { refresh?: boolean } = {}
): Promise<NotionFileRef | "rate-limited" | null> {
  const redis = await getRedis();
  const key = `notion:media:v2:${kind}:${id}:${v}`;
  if (redis && !opts.refresh) {
    try {
      const hit = await redis.get<{ url: string; media: "image" | "video" }>(key);
      if (hit?.url) return { url: hit.url, media: hit.media, fromCache: true };
    } catch {
      // 当作未命中
    }
  }

  // 本地开发没放行回源：只用缓存里的签名地址，不为每张图打一条开关报错
  if (!isNotionFetchAllowed()) return null;

  let file: { url: string; expiry_time: string } | null = null;
  let media: "image" | "video" = "image";
  const deadline = Date.now() + MEDIA_BUDGET_MS;
  try {
    const client = getClient();
    if (kind === "b") {
      const b = await withNotionRetry(() => client.blocks.retrieve({ block_id: id }), deadline);
      if (!("type" in b)) return null;
      if (b.type === "image" && b.image.type === "file") {
        file = b.image.file;
      } else if (b.type === "video" && b.video.type === "file") {
        file = b.video.file;
        media = "video";
      }
    } else {
      const page = await withNotionRetry(() => client.pages.retrieve({ page_id: id }), deadline);
      if (!("properties" in page)) return null;
      // 普通文章约定字段名是 Image；嵌入式数据库的行可能叫 Cover / Thumbnail 等，
      // 只要是 Notion files 属性且版本号匹配，就允许解析对应文件。
      for (const prop of Object.values((page as PageObjectResponse).properties)) {
        if (prop.type !== "files") continue;
        const match = prop.files.find((candidate) =>
          "file" in candidate && mediaVersion(candidate.file.url) === v
        );
        if (match && "file" in match) {
          file = match.file;
          break;
        }
      }
    }
  } catch (e) {
    console.warn(`[notion] resolveNotionFileUrl failed for ${kind}:${id}:`, e);
    if (APIResponseError.isAPIResponseError(e) && e.code === APIErrorCode.RateLimited) return "rate-limited";
    return null;
  }
  if (!file || mediaVersion(file.url) !== v) return null;

  if (redis) {
    const ttlS =
      Math.floor((new Date(file.expiry_time).getTime() - Date.now()) / 1000) - SIGNED_URL_SAFETY_S;
    if (ttlS >= 60) {
      try {
        await redis.set(key, { url: file.url, media }, { ex: ttlS });
      } catch {
        // non-fatal
      }
    }
  }
  return { url: file.url, media, fromCache: false };
}

// ---------------------------------------------------------------------------
// Notion configuration check
// ---------------------------------------------------------------------------

export function isNotionConfigured(): boolean {
  return !!(
    process.env.NOTION_TOKEN?.trim() &&
    process.env.NOTION_DATABASE_ID?.trim()
  );
}
