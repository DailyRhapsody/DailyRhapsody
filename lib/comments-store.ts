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
const INDEX_KEY = "dr:comments:index";

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

/** 一次取回多篇的评论（一个 pipeline 请求）；列表页按批加载，避免每篇各发一次请求撞上限流 */
export async function getCommentsMany(diaryIds: string[]): Promise<Record<string, Comment[]>> {
  const out: Record<string, Comment[]> = {};
  if (!redis || diaryIds.length === 0) {
    for (const id of diaryIds) out[id] = [];
    return out;
  }
  const pipe = redis.pipeline();
  for (const id of diaryIds) pipe.hgetall(threadKey(id));
  const raws = await pipe.exec();
  diaryIds.forEach((id, i) => {
    out[id] = toThread(raws[i]);
  });
  return out;
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
    .exec();
  return comment;
}

/** 删除成功返回 true；评论不存在返回 false */
export async function deleteComment(diaryId: string, commentId: string): Promise<boolean> {
  if (!redis) return false;
  return (await redis.hdel(threadKey(diaryId), commentId)) > 0;
}

/** 各篇评论数（只含有评论的篇目） */
export async function getCommentCounts(): Promise<Record<string, number>> {
  if (!redis) return {};
  const ids = (await redis.smembers(INDEX_KEY)).map(String);
  if (ids.length === 0) return {};
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hlen(threadKey(id));
  const lens = await pipe.exec();
  const counts: Record<string, number> = {};
  ids.forEach((id, i) => {
    const n = Number(lens[i]);
    if (Number.isFinite(n) && n > 0) counts[id] = n;
  });
  return counts;
}
