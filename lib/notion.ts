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
import { canonicalReferenceId } from "@/lib/reference-ids";
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
  /** Notion 的 Name 属性（数据库标题），供时间轴/树使用；不替代卡片正文。 */
  name?: string;
  summary: string; // rich text → plain text
  /** 仅 complete 的文字正文可参与全量分析；旧缓存没有此字段。 */
  bodyStatus?: "complete" | "partial" | "stale";
  /**
   * 生成 summary 的正文转换器版本。换缩进/块渲染规则时 +1：
   * 只看 sourceEditedAt 会把旧形状的正文当成可复用，导致新规则对存量文章不生效。
   */
  bodyVersion?: number;
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
// v7：正文转换支持嵌套列表缩进与 toggle 折叠块，正文形状变了，必须换键。
// 旧键 v6 留作冷启动的种子：新键还没写时把旧数据当「已过期」返回，
// 访客继续看到旧正文，后台重拉完成后自动切换，不会出现空白页。
const CACHE_KEY = "notion:diaries:v7";
const LEGACY_CACHE_KEY = "notion:diaries:v6";
/**
 * 跨项目通用别名：对外部消费者（persona-lab 人设包、scripts/tree）只暴露这一个键。
 * 历史上缓存键从 v2 → v5 → v6 → v7 升级过三次，每次都要去改下游写死的版本号，
 * 漏一处就静默读到旧数据（2026-10 博客采集断了三天才发现）。写侧每次落缓存时
 * 同步写别名，下游读别名即可，升版不再需要通知下游。
 */
const LATEST_CACHE_KEY = "notion:diaries:latest";


/**
 * 正文转换器版本。改 blockToMarkdown / 缩进 / toggle 规则时 +1。
 * 换缓存键只隔离新旧实例，不会让存量文章重新转换——必须靠这个版本号判断
 * 「旧正文是不是当前转换器产出的」，否则 v6 的正文会被当成可复用写进 v7。
 * v8：行内公式转为 $...$、行内代码支持反引号内容；正文需重转换。
 * v9：加粗/斜体/删除线按行拆分，避免跨行 `**…**` 变成字面量；正文需重转换。
 */
export const BODY_VERSION = 9;

/** 每轮刷新最多重转换多少篇老正文。全量 281 篇跑不进 200s 预算，分批迁移。 */
const BODY_MIGRATION_BATCH = 40;

/** 旧缓存是否就是当前转换器的产物（供 refresh 复用判断，也便于单测）。 */
export function bodyIsCurrent(
  old: Pick<Diary, "bodyStatus" | "bodyVersion" | "sourceEditedAt"> | undefined,
  lastEditedAt: string
): boolean {
  return (
    !!lastEditedAt &&
    old?.bodyVersion === BODY_VERSION &&
    old.bodyStatus === "complete" &&
    old.sourceEditedAt === lastEditedAt
  );
}
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
    // 别名与主键同寿命、同内容。写失败不影响主缓存，但下一轮刷新会补写；
    // 别名缺失时下游会退化成按版本号探测，不会读不到数据。
    await redis.set(LATEST_CACHE_KEY, entry, { ex: cacheTtl() });
  } catch {
    // cache write failure is non-fatal
  }
}

/**
 * Notion 自动化调用：记下过期时间并立即在后台重拉，期间访客继续看旧数据。
 * 不再删缓存——删除后首位访客要同步冷拉 80s 以上，前端 30s 超时显示「暂无文章」。
 * 别的实例正持锁刷新时，这次后台刷新拿不到锁会放弃，由持锁的那一轮收尾时补跑（refreshWithCatchUp）。
 */
/** pin 变化只需要页面属性，不需要重抓 280 篇正文。 */
const PIN_REFRESH_BUDGET_MS = 12_000;

/**
 * 先把 pin / Name 这类列表属性同步到缓存，再让全量正文刷新在后台慢慢跑。
 * Notion 自动化调 /api/revalidate 时，用户取消置顶不必等 80 秒的正文重抓才看到顺序变化。
 */
async function refreshListPropertiesOnly(): Promise<void> {
  const cached = await getCached();
  if (!cached) return;
  const client = getClient();
  const databaseId = getDatabaseId();
  const deadline = Date.now() + PIN_REFRESH_BUDGET_MS;
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
      if ("properties" in page) pages.push(page as PageObjectResponse);
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  const properties = new Map(pages.map((page) => [page.id, page]));
  const updated = cached.data.map((diary) => {
    const page = properties.get(diary.id);
    if (!page) return diary;
    return {
      ...diary,
      pinned: extractPinned(page),
      isPublic: extractIsPublic(page),
      name: extractTitle(page) || diary.name,
    };
  });
  const createdTimes = new Map(pages.map((page) => [page.id, Date.parse(page.created_time)]));
  updated.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if (a.pinned && b.pinned) return (createdTimes.get(b.id) ?? 0) - (createdTimes.get(a.id) ?? 0);
    return new Date(b.publishedAt ?? b.date).getTime() - new Date(a.publishedAt ?? a.date).getTime();
  });
  await setCache(updated, cached.snapshotAt ?? cached.refreshedAt);
}

export async function markDiariesCacheStale(): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(INVALIDATED_KEY, Date.now(), { ex: cacheTtl() });
  } catch {
    return;
  }
  try {
    await refreshListPropertiesOnly();
  } catch (e) {
    // 属性刷新失败不阻塞全量快照；后台刷新仍会尝试
    console.warn("[notion] fast list-property refresh failed:", e);
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

/** 给每个非空行单独包标记：Notion 的 bold/italic 可能横跨一行内的换行，
 *  直接把 **…** 套在整段文本上会得到「**第一行\n第二行**」，marked 不认这种跨行强调。 */
function wrapEachLine(text: string, marker: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `${marker}${line}${marker}` : line))
    .join("\n");
}

function inlineCodeForLine(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function richTextToMarkdown(items: RichTextItemResponse[]): string {
  return items
    .map((i) => {
      // Notion 行内公式是 rich_text 的一种类型，不是 text + annotation；
      // 旧代码只取 plain_text，公式会退化成普通文本。
      if (i.type === "equation") {
        const expression = i.equation.expression.trim();
        return expression ? `$${expression}$` : "";
      }
      let t = i.plain_text;
      const a = i.annotations;
      if (a.code) {
        // 内容本身可能含反引号：围栏比最长的一段再多一个，避免提前闭合。
        t = t.split("\n").map((line) => (line ? inlineCodeForLine(line) : line)).join("\n");
      }
      if (a.bold) t = wrapEachLine(t, "**");
      if (a.italic) t = wrapEachLine(t, "*");
      if (a.strikethrough) t = wrapEachLine(t, "~~");
      if (i.href) t = t.split("\n").map((line) => (line ? `[${line}](${i.href})` : line)).join("\n");
      return t;
    })
    .join("");
}

/**
 * proxyMedia：Notion 托管的图片 / 视频输出站内代理路径（见 lib/notion-media.ts）。
 * deadline：重试预算的截止时刻（见 withNotionRetry）。
 */
type BodyOptions = { proxyMedia: boolean; deadline: number; completeness?: { partial: boolean } };

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
    case "bulleted_list_item": {
      const text = richTextToMarkdown(b.bulleted_list_item.rich_text);
      // 空项只能是裸 "-"：带尾空格的 "- " 会被 marked 解析成普通段落，列表项消失
      return text ? `- ${text}` : "-";
    }
    case "numbered_list_item": {
      const text = richTextToMarkdown(b.numbered_list_item.rich_text);
      return text ? `1. ${text}` : "1.";
    }
    case "quote":
      return `> ${richTextToMarkdown(b.quote.rich_text)}`;
    case "to_do": {
      const text = richTextToMarkdown(b.to_do.rich_text);
      // 空待办没有内容可勾：GFM 要求 "] " 后有正文，输出 "- [ ]" 会渲染成字面 "[ ]"
      return text ? `- [${b.to_do.checked ? "x" : " "}] ${text}` : "";
    }
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
    case "synced_block":
    case "column_list":
    case "column":
      // 容器型 block 自身没有内容，子节点由 renderChildren 递归输出
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
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return 1000 * 2 ** attempt;
  return null;
}

export async function withNotionRetry<T>(call: () => Promise<T>, deadline: number): Promise<T> {
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

function escapeTableCell(text: string): string {
  // GFM 只要求转义 |（行内代码里的 \| 也会被还原）；反斜杠不加倍，否则行内代码里会多出一个
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
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
 * 列表项的「族」：相邻同族项用单换行连接，否则 marked 会判成 loose list（每项包一层 <p>）；
 * 异族之间、列表与段落之间才用空行。
 */
type ListFamily = "bullet" | "number" | "todo";

/** 一个已渲染块：family 只用于决定与相邻块之间的分隔符。 */
type Emitted = { text: string; family: ListFamily | null };

/** 本层行首缩进；width 只在列表项里非零，表示子块要缩进到它的正文列。 */
type BlockCtx = { indent: number; width: number };

const LIST_FAMILY: Partial<Record<BlockObjectResponse["type"], ListFamily>> = {
  bulleted_list_item: "bullet",
  numbered_list_item: "number",
  to_do: "todo",
};

/**
 * 子块缩进步长取父项的标记宽度：无序 2（"- "）、有序 3（"1. "）、待办 4。
 * 待办的正文列其实是 6（"- [ ] "），但 marked 在缩进 6 时会把嵌套列表降级成文本，
 * 取 4 才既能嵌套三层、又保留待办方框。
 */
const MARKER_WIDTH: Record<ListFamily, number> = { bullet: 2, number: 3, todo: 4 };

function indentLines(text: string, n: number): string {
  if (!text || n <= 0) return text;
  const pad = " ".repeat(n);
  return text.split("\n").map((line) => (line.trim() === "" ? "" : pad + line)).join("\n");
}

/** 列表项首行落在 indent，续行（Shift+Enter 的换行）落到正文列，否则会被解析成新块。 */
function indentListItem(text: string, indent: number, width: number): string {
  if (!text) return text;
  const [first, ...rest] = text.split("\n");
  const pad = " ".repeat(indent);
  const cont = " ".repeat(indent + width);
  return [pad + first, ...rest.map((line) => (line.trim() === "" ? "" : cont + line))].join("\n");
}

/**
 * 块之间的分隔符：同族相邻列表项用单换行（连续列表），其余用空行。
 * 早先所有块统一用空行拼接，子块因此与父块同级——嵌套在数据层就被拍平了。
 */
function joinEmitted(items: Emitted[]): string {
  let out = "";
  let prev: ListFamily | null = null;
  for (const item of items) {
    const sep = out === "" ? "" : prev !== null && prev === item.family ? "\n" : "\n\n";
    out += sep + item.text;
    prev = item.family;
  }
  return out;
}

function toggleMarkdown(title: string, inner: Emitted[]): string {
  const body = inner.length ? `\n\n${joinEmitted(inner)}` : "";
  // 与 callout 同构：用引用块承载私有标记，渲染器再把它换成 <details>。
  // 直接把 HTML 写进正文不可行——highlightHashtagsForRender 会把 "<" 转义。
  return `[!NOTION-TOGGLE] ${title}${body}`
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * 递归遍历 page 下的所有 block，返回「已渲染块」而不是共享数组：
 * 子块必须带着自己的缩进与族标记回到父层，否则嵌套关系无法表达。
 * Notion API 对每个有 has_children 的 block 都需要再调一次 list；这里限制深度避免循环。
 */
async function renderChildren(
  blockId: string,
  ctx: BlockCtx,
  depth: number,
  opts: BodyOptions,
  maxDepth: number
): Promise<Emitted[]> {
  const out: Emitted[] = [];
  if (depth > maxDepth) {
    if (opts.completeness) opts.completeness.partial = true;
    return out;
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
        if (table) out.push({ text: indentLines(table, ctx.indent), family: null });
        continue;
      }
      if (block.type === "toggle") {
        const inner = block.has_children
          ? await renderChildren(block.id, { indent: 0, width: 0 }, depth + 1, opts, maxDepth)
          : [];
        const md = toggleMarkdown(richTextToMarkdown(block.toggle.rich_text), inner);
        out.push({ text: indentLines(md, ctx.indent), family: null });
        continue;
      }
      if (block.type === "callout" || block.type === "quote") {
        const content = [richTextToMarkdown(block.type === "callout" ? block.callout.rich_text : block.quote.rich_text)];
        if (block.has_children) {
          const inner = await renderChildren(block.id, { indent: 0, width: 0 }, depth + 1, opts, maxDepth);
          if (inner.length) content.push(joinEmitted(inner));
        }
        if (block.type === "callout") {
          const icon = block.callout.icon;
          const emoji = icon?.type === "emoji" ? icon.emoji : "💡";
          content.unshift(`[!NOTION-CALLOUT] ${emoji}`);
        }
        const quoted = content.join("\n\n").split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
        out.push({ text: indentLines(quoted, ctx.indent), family: null });
        continue;
      }
      const family = LIST_FAMILY[block.type] ?? null;
      const md = blockToMarkdown(block, opts);
      // 未支持的文字块不能静默认证为全文；图片/视频本身不在文字分析范围。
      if (opts.completeness && block.type === "unsupported") {
        opts.completeness.partial = true;
      }
      if (!md) {
        // 容器块（column_list / column / synced_block）自身没有文本，但子块必须递归输出。
        // 早先把递归写在 if (md) 里，两栏与同步块的内容会整段消失且不置 partial。
        if (block.has_children) {
          out.push(...(await renderChildren(block.id, { indent: ctx.indent, width: 0 }, depth + 1, opts, maxDepth)));
        }
        continue;
      }
      let text = family ? indentListItem(md, ctx.indent, MARKER_WIDTH[family]) : indentLines(md, ctx.indent);
      if (block.has_children) {
        const next: BlockCtx = family
          ? { indent: ctx.indent + MARKER_WIDTH[family], width: MARKER_WIDTH[family] }
          : { indent: ctx.indent, width: 0 };
        const kids = await renderChildren(block.id, next, depth + 1, opts, maxDepth);
        if (kids.length) {
          // 子块并进本块的文本里，不能用兄弟级分隔符：列表族不同（有序套无序）时
          // 若走 "\n\n" 会在父项与子列表之间插空行，反过来把外层有序列表切断。
          text += (kids[0].family ? "\n" : "\n\n") + joinEmitted(kids);
        }
      }
      out.push({ text, family });
    }
    cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

/** 抓取失败返回 null，让全量刷新能区分「正文确实为空」和「这次没抓到」。 */
async function tryExtractBodyMarkdown(
  pageId: string,
  opts: BodyOptions
): Promise<string | null> {
  try {
    // 展示路径也用 32 层：以前列表被拍平，3 层很少被触到；现在嵌套是显式特性，
    // 4 层以上的文章会在编辑页 / Reference 页静默少内容。32 层只是防环的上限。
    const parts = await renderChildren(pageId, { indent: 0, width: 0 }, 0, opts, 32);
    return joinEmitted(parts);
  } catch (e) {
    console.warn(`[notion] extractBodyMarkdown failed for ${pageId}:`, e);
    return null;
  }
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
  pageIds: string[],
  deadline: number,
  concurrency = 3
): Promise<Map<string, { text: string; complete: boolean } | null>> {
  const out = new Map<string, { text: string; complete: boolean } | null>();
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, pageIds.length) }, async () => {
    while (idx < pageIds.length && Date.now() < deadline) {
      const i = idx++;
      const id = pageIds[i];
      const completeness = { partial: false };
      const text = await tryExtractBodyMarkdown(id, { proxyMedia: true, deadline, completeness });
      out.set(id, text === null ? null : { text, complete: !completeness.partial });
    }
  });
  await Promise.all(workers);
  const skipped = pageIds.length - out.size;
  const failed = [...out.values()].filter((body) => body === null).length;
  if (skipped + failed > 0) {
    console.warn(
      `[notion] ${skipped + failed}/${pageIds.length} bodies kept from previous snapshot ` +
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
// Image extraction from the "Image" Files property
// Image 字段是多文件属性；顶部图片区最多展示 3 张，数据层必须全部保留，
// 不能只取 files[0]，否则用户放两张时第二张会静默丢失。
// ---------------------------------------------------------------------------

function extractImages(page: PageObjectResponse): string[] {
  const prop = page.properties["Image"];
  if (prop?.type !== "files") return [];
  return prop.files.flatMap((file) => {
    if (file.type === "file") {
      return [mediaProxyPath("p", page.id, file.file.url)];
    }
    if (file.type === "external") {
      return [file.external.url];
    }
    return [];
  });
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
    name: title || undefined,
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

  const previous = new Map((await getCached())?.data.map((d) => [d.id, d]) ?? []);
  const reusable = (page: PageObjectResponse) => bodyIsCurrent(previous.get(page.id), page.last_edited_time);
  const pending = pages.filter((p) => !reusable(p));
  // 老转换器产出的完整正文要重抓，但 281 篇跑不进 200s 预算：一轮只迁移一批，
  // 没轮到的保留旧正文并维持 complete（它确实是完整文档，只是旧形状），
  // 否则会被标成 stale，让文章分析反复 202。新文章与被编辑过的文章永远优先。
  const legacy = pending.filter((p) => {
    const old = previous.get(p.id);
    return !!old && old.bodyStatus === "complete" && old.bodyVersion !== BODY_VERSION;
  });
  const legacyIds = new Set(legacy.map((p) => p.id));
  const edited = pending.filter((p) => !legacyIds.has(p.id));
  const migrationBudget = Math.max(0, BODY_MIGRATION_BATCH - edited.length);
  const fetched = legacy.slice(0, migrationBudget);
  const skippedForMigration = new Set(legacy.slice(migrationBudget).map((p) => p.id));
  const bodies = await extractBodyMarkdownBatch(
    [...edited, ...fetched].map((p) => p.id),
    deadline
  );
  // 重试用尽或预算用完仍没抓到的正文沿用上一版缓存，不让一次限流把好数据覆盖成只剩标题
  const diaries = pages.map((page) => {
    const body = bodies.get(page.id);
    const old = previous.get(page.id);
    return {
      ...mapPageToDiary(page, body?.text ?? old?.summary ?? ""),
      sourceEditedAt: page.last_edited_time,
      bodyVersion: body ? BODY_VERSION : old?.bodyVersion,
      bodyStatus: body
        ? body.complete
          ? ("complete" as const)
          : ("partial" as const)
        : skippedForMigration.has(page.id) || reusable(page)
          ? ("complete" as const)
          : ("stale" as const),
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

    const body = await extractBodyMarkdown(id, { proxyMedia: true, deadline });
    const diary = mapPageToDiary(page as PageObjectResponse, body ?? "");
    // 详情路径是现抓的正文：抓到就标记为当前转换器版本，抓不到（限流/超预算）
    // 不能声称完整，交给调用方按空正文处理。
    return body === null
      ? diary
      : { ...diary, bodyVersion: BODY_VERSION, bodyStatus: "complete" as const };
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
  /** Image/Cover 都是 files 多值属性；版本号要匹配具体那一项，不能只看 files[0]。 */
  const pickFile = (files: unknown, version: string) => {
    if (!Array.isArray(files)) return null;
    for (const item of files) {
      if (
        item &&
        typeof item === "object" &&
        "type" in item &&
        item.type === "file" &&
        "file" in item &&
        item.file &&
        typeof item.file === "object" &&
        "url" in item.file &&
        typeof item.file.url === "string" &&
        mediaVersion(item.file.url) === version
      ) {
        return item.file as { url: string; expiry_time: string };
      }
    }
    return null;
  };
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
    } else if (kind === "r") {
      // Reference 卡片封面：优先 Cover 属性，其次 page.cover。
      // 只认 Notion 托管文件，外链封面不走代理。媒体路径里的 id 去掉了连字符，
      // Notion 的 pages.retrieve 需要规范 id。
      const page = await withNotionRetry(
        () => client.pages.retrieve({ page_id: canonicalReferenceId(id) }),
        deadline
      );
      if (!("properties" in page)) return null;
      const full = page as PageObjectResponse;
      const coverProp = full.properties["Cover"];
      file =
        pickFile(coverProp?.type === "files" ? coverProp.files : undefined, v) ??
        (full.cover?.type === "file" && mediaVersion(full.cover.file.url) === v ? full.cover.file : null);
    } else {
      const page = await withNotionRetry(() => client.pages.retrieve({ page_id: id }), deadline);
      if (!("properties" in page)) return null;
      const prop = (page as PageObjectResponse).properties["Image"];
      file = pickFile(prop?.type === "files" ? prop.files : undefined, v);
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
