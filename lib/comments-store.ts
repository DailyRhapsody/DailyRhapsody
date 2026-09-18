import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

export type Comment = {
  id: string;
  diaryId: string;
  author: string;
  content: string;
  createdAt: string; // ISO
  /** 访客头像：头像库编号（1..COMMENT_AVATAR_COUNT）。站长评论用站点头像，不带 */
  avatar?: number;
  /** 站长（已登录后台）发的评论 */
  isAuthor?: boolean;
};

/** public/comment-avatars/ 里的头像数量，与 components/entries/CommentAvatar.tsx 一致 */
export const COMMENT_AVATAR_COUNT = 36;
/** 单篇评论上限，防止被刷爆 */
export const MAX_COMMENTS_PER_DIARY = 500;

export class CommentLimitError extends Error {}
export class CommentsUnavailableError extends Error {}

/**
 * 评论存 Upstash：每篇一个 hash（field 为评论 id）。旧实现写 data/comments.json，
 * Vercel serverless 部署目录只读、实例间不共享，生产上发表必失败、读永远为空。
 *
 * 各篇评论数不单独记计数器（删最后一条与新发表并发时计数会丢），而是记一个只增不减的
 * 「有过评论的篇目」集合，取数时逐篇 HLEN，数字永远与线程一致。
 * 没有 KV 凭证时评论不可用：读返回空、写报不可用。
 */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
// 自己做 JSON 编解码：评论正文可能恰好是一段合法 JSON（如纯数字），自动反序列化会把它变成别的类型
const redis =
  redisUrl && redisToken
    ? new Redis({ url: redisUrl, token: redisToken, automaticDeserialization: false })
    : null;

const threadKey = (diaryId: string) => `dr:comments:${diaryId}`;

/** Notion 页面 id（带或不带连字符）。也挡住与 dr:comments:index 等同前缀的内部键名 */
const PAGE_ID_RE = /^[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}$/i;
export function isDiaryId(id: string): boolean {
  return PAGE_ID_RE.test(id);
}
const INDEX_KEY = "dr:comments:index";
/** 各篇评论数的短缓存；发表、删除时清掉，所有实例看到的都一致 */
const COUNTS_CACHE_KEY = "dr:comments:counts";
const COUNTS_TTL_S = 30;

export function isCommentsStoreConfigured(): boolean {
  return redis !== null;
}

function parseComment(raw: unknown): Comment | null {
  if (typeof raw !== "string") return null;
  try {
    const c = JSON.parse(raw) as Partial<Comment>;
    if (typeof c.id !== "string" || typeof c.content !== "string" || typeof c.createdAt !== "string") {
      return null;
    }
    return {
      id: c.id,
      diaryId: typeof c.diaryId === "string" ? c.diaryId : "",
      author: typeof c.author === "string" && c.author ? c.author : "匿名",
      content: c.content,
      createdAt: c.createdAt,
      ...(typeof c.avatar === "number" ? { avatar: c.avatar } : {}),
      ...(c.isAuthor === true ? { isAuthor: true } : {}),
    };
  } catch {
    return null;
  }
}

/** 关闭自动反序列化后 HGETALL 返回扁平数组 [field, value, …] */
function hashValues(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw.filter((_, i) => i % 2 === 1);
  if (raw && typeof raw === "object") return Object.values(raw as Record<string, unknown>);
  return [];
}

function byTime(a: Comment, b: Comment): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function toThread(raw: unknown): Comment[] {
  return hashValues(raw)
    .map(parseComment)
    .filter((c): c is Comment => c !== null)
    .sort(byTime);
}

/** 批量响应的体积上限：Vercel 函数响应上限 4.5MB，留出余量 */
const BATCH_BYTES_MAX = 3_000_000;

/**
 * 一次取回多篇的评论（一个 pipeline 请求）；列表页按批加载，避免每篇各发一次请求撞上限流。
 * 累计体积超过上限就停下，没放进去的篇目放在 pending 里，由前端下一批再取。
 */
export async function getCommentsMany(
  diaryIds: string[]
): Promise<{ threads: Record<string, Comment[]>; pending: string[] }> {
  const threads: Record<string, Comment[]> = {};
  if (!redis || diaryIds.length === 0) {
    for (const id of diaryIds) threads[id] = [];
    return { threads, pending: [] };
  }
  const pipe = redis.pipeline();
  for (const id of diaryIds) pipe.hgetall(threadKey(id));
  const raws = await pipe.exec();
  let bytes = 0;
  const pending: string[] = [];
  diaryIds.forEach((id, i) => {
    const thread = toThread(raws[i]);
    const size = Buffer.byteLength(JSON.stringify(thread));
    // 第一篇无论多大都放进去，否则它会永远取不到
    if (bytes > 0 && bytes + size > BATCH_BYTES_MAX) {
      pending.push(id);
      return;
    }
    bytes += size;
    threads[id] = thread;
  });
  return { threads, pending };
}

export async function addComment(
  input: Omit<Comment, "id" | "createdAt">
): Promise<Comment> {
  if (!redis) throw new CommentsUnavailableError();
  const key = threadKey(input.diaryId);
  if ((await redis.hlen(key)) >= MAX_COMMENTS_PER_DIARY) throw new CommentLimitError();
  const comment: Comment = {
    ...input,
    id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  };
  await redis
    .multi()
    .hset(key, { [comment.id]: JSON.stringify(comment) })
    .sadd(INDEX_KEY, input.diaryId)
    .del(COUNTS_CACHE_KEY)
    .exec();
  return comment;
}

/** 删除成功返回 true；评论不存在返回 false */
export async function deleteComment(diaryId: string, commentId: string): Promise<boolean> {
  if (!redis) return false;
  const removed = (await redis.hdel(threadKey(diaryId), commentId)) > 0;
  if (removed) await redis.del(COUNTS_CACHE_KEY);
  return removed;
}

/**
 * 各篇评论数（只含有评论的篇目）。known：日记库里现有的篇目（含私密），只对这些篇目查条数，
 * 已删篇不产生开销；按访客 / 站长可见范围过滤由调用方负责。
 * 每次打开博客页都会取一次，逐篇 HLEN 按条计费，所以结果在 Redis 里缓存 30 秒。
 */
export async function getCommentCounts(known: ReadonlySet<string>): Promise<Record<string, number>> {
  if (!redis) return {};
  const cached = await redis.get(COUNTS_CACHE_KEY);
  if (typeof cached === "string") {
    try {
      const all = JSON.parse(cached) as Record<string, number>;
      return Object.fromEntries(Object.entries(all).filter(([id]) => known.has(id)));
    } catch {
      // 缓存损坏：按未命中处理
    }
  }
  const ids = (await redis.smembers(INDEX_KEY)).map(String).filter((id) => known.has(id));
  const counts: Record<string, number> = {};
  if (ids.length > 0) {
    const pipe = redis.pipeline();
    for (const id of ids) pipe.hlen(threadKey(id));
    const lens = await pipe.exec();
    ids.forEach((id, i) => {
      const n = Number(lens[i]);
      if (Number.isFinite(n) && n > 0) counts[id] = n;
    });
  }
  await redis.set(COUNTS_CACHE_KEY, JSON.stringify(counts), { ex: COUNTS_TTL_S });
  return counts;
}
