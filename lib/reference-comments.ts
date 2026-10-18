/**
 * Reference 评论存储（独立键空间）。
 *
 * 为什么不复用 lib/comments-store.ts：那边的 INDEX_KEY / COUNTS_GEN_KEY 是全局单键，
 * 每次 Reference 评论都会击穿日记评论计数缓存；Comment.diaryId 的语义也会错位。
 * 这里全部独立，日记键 `dr:comments:<id>` 字节级不变。
 *
 * 键：
 *   dr:ref:comments:<threadId>   hash，field=评论 id
 *   dr:ref:comments:index        set，有过评论的 threadId
 *   dr:ref:comments:counts       string，30s 计数缓存（带 gen）
 *   dr:ref:comments:gen          string，发表/删除时 +1
 */

import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { canonicalReferenceId, isReferencePageId } from "@/lib/reference-ids";

export type ReferenceComment = {
  id: string;
  threadId: string;
  author: string;
  content: string;
  createdAt: string; // ISO
  avatar?: number;
  isAuthor?: boolean;
};

export const REFERENCE_COMMENT_AVATAR_COUNT = 36;
export const MAX_REFERENCE_COMMENTS = 500;

export class ReferenceCommentLimitError extends Error {}
export class ReferenceCommentsUnavailableError extends Error {}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
// 自己 JSON 编解码：评论正文可能恰好是合法 JSON（纯数字等），自动反序列化会改类型
const redis =
  redisUrl && redisToken
    ? new Redis({ url: redisUrl, token: redisToken, automaticDeserialization: false })
    : null;

const threadKey = (threadId: string) => `dr:ref:comments:${canonicalReferenceId(threadId)}`;
const INDEX_KEY = "dr:ref:comments:index";
const COUNTS_CACHE_KEY = "dr:ref:comments:counts";
const COUNTS_GEN_KEY = "dr:ref:comments:gen";
const COUNTS_TTL_S = 30;

export function isReferenceThreadId(id: string): boolean {
  return isReferencePageId(id);
}

export function isReferenceCommentsConfigured(): boolean {
  return redis !== null;
}

function parseComment(raw: unknown): ReferenceComment | null {
  if (typeof raw !== "string") return null;
  try {
    const c = JSON.parse(raw) as Partial<ReferenceComment>;
    if (typeof c.id !== "string" || typeof c.content !== "string" || typeof c.createdAt !== "string") {
      return null;
    }
    return {
      id: c.id,
      threadId: typeof c.threadId === "string" ? c.threadId : "",
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

/** automaticDeserialization=false 时 HGETALL 返回扁平数组 [field, value, …] */
function hashValues(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw.filter((_, i) => i % 2 === 1);
  if (raw && typeof raw === "object") return Object.values(raw as Record<string, unknown>);
  return [];
}

function byTime(a: ReferenceComment, b: ReferenceComment): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function toThread(raw: unknown): ReferenceComment[] {
  return hashValues(raw)
    .map(parseComment)
    .filter((c): c is ReferenceComment => c !== null)
    .sort(byTime);
}

const BATCH_BYTES_MAX = 3_000_000;

/** 一次取多条的线程；超体积的放进 pending，由前端下一批再取。 */
export async function getReferenceCommentsMany(
  threadIds: string[]
): Promise<{ threads: Record<string, ReferenceComment[]>; pending: string[] }> {
  // 两种 id 写法必须归一到同一条线程，否则 /reference/<dashed> 与 <dashless> 会各写一份
  const ids = [...new Set(threadIds.map(canonicalReferenceId))];
  const threads: Record<string, ReferenceComment[]> = {};
  if (!redis || ids.length === 0) {
    for (const id of ids) threads[id] = [];
    return { threads, pending: [] };
  }
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(threadKey(id));
  const raws = await pipe.exec();

  let bytes = 0;
  const pending: string[] = [];
  ids.forEach((id, i) => {
    const thread = toThread(raws[i]);
    const size = Buffer.byteLength(JSON.stringify(thread));
    if (bytes > 0 && bytes + size > BATCH_BYTES_MAX) {
      pending.push(id);
      return;
    }
    bytes += size;
    threads[id] = thread;
  });
  return { threads, pending };
}

export async function addReferenceComment(
  input: Omit<ReferenceComment, "id" | "createdAt">
): Promise<ReferenceComment> {
  if (!redis) throw new ReferenceCommentsUnavailableError();
  const threadId = canonicalReferenceId(input.threadId);
  const key = threadKey(threadId);
  if ((await redis.hlen(key)) >= MAX_REFERENCE_COMMENTS) {
    throw new ReferenceCommentLimitError();
  }
  const comment: ReferenceComment = {
    ...input,
    threadId,
    id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  };
  await redis
    .multi()
    .hset(key, { [comment.id]: JSON.stringify(comment) })
    .sadd(INDEX_KEY, threadId)
    .incr(COUNTS_GEN_KEY)
    .exec();
  return comment;
}

export async function deleteReferenceComment(
  threadId: string,
  commentId: string
): Promise<boolean> {
  if (!redis) return false;
  const key = threadKey(threadId);
  const removed = (await redis.hdel(key, commentId)) > 0;
  if (removed) await redis.incr(COUNTS_GEN_KEY);
  return removed;
}

/** 各 thread 的评论数（只含有关注的 thread）。30s 缓存，带 gen 防并发脏读。 */
export async function getReferenceCommentCounts(
  known: ReadonlySet<string>
): Promise<Record<string, number>> {
  if (!redis) return {};
  const knownIds = new Set([...known].map(canonicalReferenceId));
  const [cached, genRaw] = await redis.mget(COUNTS_CACHE_KEY, COUNTS_GEN_KEY);
  const gen = String(genRaw ?? "0");
  if (typeof cached === "string") {
    try {
      const hit = JSON.parse(cached) as { gen?: string; counts?: Record<string, number> };
      if (hit.gen === gen && hit.counts) {
        return Object.fromEntries(
          Object.entries(hit.counts).filter(([id]) => knownIds.has(id))
        );
      }
    } catch {
      // 缓存损坏：按未命中处理
    }
  }
  const ids = (await redis.smembers(INDEX_KEY)).map(String).filter((id) => knownIds.has(id));
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
  await redis.set(COUNTS_CACHE_KEY, JSON.stringify({ gen, counts }), { ex: COUNTS_TTL_S });
  return counts;
}
