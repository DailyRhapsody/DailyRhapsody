import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * 与 profile-store 同理：Vercel serverless 的部署目录只读、实例间不共享也不持久，写本地文件的
 * 评论在生产从来存不住（发表必 500，读永远为空）。有 KV 凭证时一律走 Upstash Redis：
 * 每篇一个 hash（field 为评论 id），另有一个计数 hash 供列表页一次取回各篇评论数。
 * 无凭证的环境（离线本地）退回文件存储。
 */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
// 自己做 JSON 编解码：评论正文可能恰好是一段合法 JSON（如纯数字），自动反序列化会把它变成别的类型
const redis =
  redisUrl && redisToken
    ? new Redis({ url: redisUrl, token: redisToken, automaticDeserialization: false })
    : null;

const threadKey = (diaryId: string) => `dr:comments:${diaryId}`;
const COUNTS_KEY = "dr:comment-counts";

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

/** 关闭自动反序列化后 HGETALL 返回扁平数组 [field, value, …]，这里统一成对象 */
function hashEntries(raw: unknown): [string, string][] {
  if (Array.isArray(raw)) {
    const out: [string, string][] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) out.push([String(raw[i]), String(raw[i + 1])]);
    return out;
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
  }
  return [];
}

function byTime(a: Comment, b: Comment): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/* ── 离线本地：文件存储 ── */

const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "comments.json");

async function readFromFile(): Promise<Comment[]> {
  try {
    const data = JSON.parse(await readFile(DATA_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeToFile(comments: Comment[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(comments, null, 2), "utf8");
}

/* ── 对外接口 ── */

export async function getComments(diaryId: string): Promise<Comment[]> {
  if (!redis) {
    return (await readFromFile()).filter((c) => c.diaryId === diaryId).sort(byTime);
  }
  return hashEntries(await redis.hgetall(threadKey(diaryId)))
    .map(([, v]) => parseComment(v))
    .filter((c): c is Comment => c !== null)
    .sort(byTime);
}

export async function addComment(
  input: Omit<Comment, "id" | "createdAt">
): Promise<Comment> {
  const comment: Comment = {
    ...input,
    id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  };
  if (!redis) {
    const all = await readFromFile();
    if (all.filter((c) => c.diaryId === input.diaryId).length >= MAX_COMMENTS_PER_DIARY) {
      throw new CommentLimitError();
    }
    all.push(comment);
    await writeToFile(all);
    return comment;
  }
  const key = threadKey(input.diaryId);
  if ((await redis.hlen(key)) >= MAX_COMMENTS_PER_DIARY) throw new CommentLimitError();
  await redis
    .multi()
    .hset(key, { [comment.id]: JSON.stringify(comment) })
    .hincrby(COUNTS_KEY, input.diaryId, 1)
    .exec();
  return comment;
}

/** 删除成功返回 true；评论不存在返回 false */
export async function deleteComment(diaryId: string, commentId: string): Promise<boolean> {
  if (!redis) {
    const all = await readFromFile();
    const rest = all.filter((c) => !(c.diaryId === diaryId && c.id === commentId));
    if (rest.length === all.length) return false;
    await writeToFile(rest);
    return true;
  }
  const removed = await redis.hdel(threadKey(diaryId), commentId);
  if (removed === 0) return false;
  const left = await redis.hincrby(COUNTS_KEY, diaryId, -1);
  if (left <= 0) await redis.hdel(COUNTS_KEY, diaryId);
  return true;
}

/** 各篇评论数（只含有评论的篇目） */
export async function getCommentCounts(): Promise<Record<string, number>> {
  if (!redis) {
    const counts: Record<string, number> = {};
    for (const c of await readFromFile()) counts[c.diaryId] = (counts[c.diaryId] ?? 0) + 1;
    return counts;
  }
  const counts: Record<string, number> = {};
  for (const [id, v] of hashEntries(await redis.hgetall(COUNTS_KEY))) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) counts[id] = n;
  }
  return counts;
}
