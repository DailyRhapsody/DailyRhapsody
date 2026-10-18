/**
 * 博客评论 ↔ Notion 页面评论双向同步。
 *
 * 方向一（博客 → Notion）：评论写进 Upstash 后，用后台任务在文章页面上建一条
 * Notion 评论，并把返回的 comment id 回写到博客评论记录，供删除时对账。
 * 方向二（Notion → 博客）：作者在 Notion 页面评论里新增、编辑、删除评论时，
 * Notion 的 webhook 会带着 comment id 与 page id 推过来，这里把变化写回
 * Upstash，博客访客随即看到。
 *
 * 三条必须守住的不变式：
 * 1. 防循环：我们自己同步过去的评论会再触发 comment.created，作者是 bot，
 *    一律忽略；只有 person 白名单里的账号才算作者本人的操作。
 * 2. 幂等：同一事件可能重试最多 8 次；同一 comment id 也可能被重复投递。
 *    事件 id 与映射键都要先占位再处理，删除后留 tombstone，避免旧事件把
 *    已删评论复活。
 * 3. 不拖慢访客：Notion 调用全部在后台任务或 webhook 里做，失败只进待补
 *    队列，绝不影响评论提交的响应。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Comment } from "./comments-store";
import {
  addComment,
  deleteComment,
  getComment,
  getCommentsRedis,
  setNotionCommentId,
  updateCommentContent,
} from "./comments-store";
import { getCachedDiaries } from "./notion";
import { getProfile } from "./profile-store";

const NOTION_API = "https://api.notion.com/v1";
/** File Upload / Comments 在 2022-06-28 版本下可用（已实测） */
const NOTION_VERSION = "2022-06-28";

const MAPPING_PREFIX = "dr:comment-notion:";
const EVENT_PREFIX = "dr:notion-event:";
const PENDING_KEY = "dr:comment-sync:pending";
/** 删除后保留映射占位，防止重放的旧事件把评论原地复活 */
const TOMBSTONE_TTL_S = 30 * 24 * 60 * 60;
const EVENT_TTL_S = 24 * 60 * 60;
/** 待补任务重试间隔与上限 */
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
/** 评论正文加到 Notion 的单项上限 */
const MAX_TEXT = 2000;

export type NotionCommentEvent = {
  id?: unknown;
  type?: unknown;
  timestamp?: unknown;
  authors?: unknown;
  entity?: unknown;
  data?: unknown;
};

type SyncPending = {
  action: "create" | "delete";
  diaryId: string;
  commentId: string;
  notionCommentId?: string;
  attempts: number;
};

function token(): string | null {
  return process.env.NOTION_TOKEN?.trim() || null;
}

export function isCommentSyncConfigured(): boolean {
  return token() !== null;
}

/**
 * 把同步任务挂到响应之后执行。Vercel 上交给 waitUntil 保住函数生命周期；
 * 本地或自托管没有这个模块时任务已经启动，忽略即可。
 * 任务自身的异常一律吞掉——同步失败不能冒泡到评论接口。
 */
export function runInBackground(task: () => Promise<void>): void {
  const running = task().catch(() => {});
  import("@vercel/functions")
    .then(({ waitUntil }) => waitUntil(running))
    .catch(() => {
      // 没有 @vercel/functions：任务已在跑，不额外处理
    });
}

function notionHeaders(withBody: boolean): Record<string, string> {
  const t = token();
  if (!t) throw new Error("NOTION_TOKEN 未配置");
  return {
    Authorization: `Bearer ${t}`,
    "Notion-Version": NOTION_VERSION,
    ...(withBody ? { "Content-Type": "application/json" } : {}),
  };
}

async function notionFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: { ...notionHeaders(!!init?.body), ...(init?.headers as Record<string, string> | undefined) },
  });
}

/** Notion 的 rich_text 转纯文本：mention 用其 plain_text，链接保留文字 */
function richTextToPlain(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const it = item as { plain_text?: unknown; text?: { content?: unknown } };
      if (typeof it.plain_text === "string") return it.plain_text;
      return typeof it.text?.content === "string" ? it.text.content : "";
    })
    .join("");
}

/** 正文进 Notion 前统一清洗，长度按单项上限截断；昵称放最前面，读者才知道是谁 */
export function buildCommentText(comment: Comment, authorName: string): string {
  const who = comment.isAuthor ? authorName : comment.author?.trim() || "匿名";
  const body = comment.content.trim();
  const head = `${who}：`;
  return `${head}${body}`.slice(0, MAX_TEXT);
}

export function verifyNotionSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const hex = header.slice("sha256=".length).trim();
  // timingSafeEqual 长度不等会抛异常，先把形状钉死
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest();
  const given = Buffer.from(hex, "hex");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// 站长白名单：只认作者本人，其他成员或集成的评论不进博客
// ---------------------------------------------------------------------------

let ownerCache: { ids: Set<string>; at: number } | null = null;
const OWNER_TTL_MS = 60 * 60 * 1000;

async function ownerIds(): Promise<Set<string>> {
  const configured = process.env.NOTION_OWNER_USER_ID?.trim();
  if (configured) return new Set([configured]);
  if (ownerCache && Date.now() - ownerCache.at < OWNER_TTL_MS) return ownerCache.ids;
  try {
    const res = await notionFetch("/users?page_size=100");
    if (!res.ok) return new Set();
    const body = (await res.json()) as { results?: { id?: string; type?: string }[] };
    const ids = new Set(
      (body.results ?? [])
        .filter((u) => u.type === "person" && typeof u.id === "string")
        .map((u) => u.id as string)
    );
    ownerCache = { ids, at: Date.now() };
    return ids;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// 正向：博客 → Notion
// ---------------------------------------------------------------------------

async function createNotionComment(diaryId: string, text: string): Promise<string | null> {
  try {
    const res = await notionFetch("/comments", {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: diaryId },
        rich_text: [{ type: "text", text: { content: text } }],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

async function deleteNotionComment(notionCommentId: string): Promise<boolean> {
  try {
    const res = await notionFetch(`/comments/${notionCommentId}`, { method: "DELETE" });
    // 404 说明已经被删掉，视为完成
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

function redisOrNull() {
  return getCommentsRedis();
}

async function enqueue(item: Omit<SyncPending, "attempts">, attempts: number): Promise<void> {
  const redis = redisOrNull();
  if (!redis) return;
  const payload: SyncPending = { ...item, attempts };
  try {
    await redis.zadd(PENDING_KEY, {
      score: Date.now() + RETRY_DELAY_MS * Math.max(1, attempts),
      member: JSON.stringify(payload),
    });
  } catch {
    // 待补队列本身失败只能放弃，评论已经写入，不能反过来影响访客
  }
}

/**
 * 评论提交后的后台同步。调用方用 waitUntil 包住，不要 await 到响应路径上。
 */
export async function syncCreatedComment(diaryId: string, comment: Comment): Promise<void> {
  if (!isCommentSyncConfigured()) return;
  const redis = redisOrNull();
  if (!redis) return;
  // 评论可能在后台任务排队期间被作者删掉
  const before = await getComment(diaryId, comment.id);
  if (!before) return;
  const notionId = await createNotionComment(diaryId, buildCommentText(before, (await getProfile()).name));
  if (!notionId) {
    await enqueue({ action: "create", diaryId, commentId: comment.id }, 0);
    return;
  }
  // 创建期间评论被删了：把刚建出来的 Notion 评论删掉，避免孤儿
  const after = await getComment(diaryId, comment.id);
  if (!after) {
    await deleteNotionComment(notionId);
    return;
  }
  const ok = await setNotionCommentId(diaryId, comment.id, notionId);
  if (!ok) {
    await deleteNotionComment(notionId);
    return;
  }
  try {
    await redis.set(MAPPING_PREFIX + notionId, comment.id);
  } catch {
    // 映射写不进去只会影响后续删除/编辑，评论本身已经同步完成
  }
}

/** 删除评论后的后台同步 */
export async function syncDeletedComment(comment: Comment): Promise<void> {
  if (!isCommentSyncConfigured() || !comment.notionCommentId) return;
  const redis = redisOrNull();
  const ok = await deleteNotionComment(comment.notionCommentId);
  if (!ok) {
    await enqueue(
      { action: "delete", diaryId: comment.diaryId, commentId: comment.id, notionCommentId: comment.notionCommentId },
      0
    );
    return;
  }
  if (redis) {
    try {
      await redis.set(MAPPING_PREFIX + comment.notionCommentId, "deleted", { ex: TOMBSTONE_TTL_S });
    } catch {
      // 同上
    }
  }
}

// ---------------------------------------------------------------------------
// 反向：Notion → 博客
// ---------------------------------------------------------------------------

type ParsedEvent = {
  id: string;
  type: "comment.created" | "comment.updated" | "comment.deleted";
  timestamp: number;
  commentId: string;
  pageId: string;
  authorId: string;
  authorType: string;
};

export function parseNotionEvent(raw: unknown): ParsedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const type = e.type;
  if (type !== "comment.created" && type !== "comment.updated" && type !== "comment.deleted") return null;
  if (typeof e.id !== "string") return null;
  const entity = e.entity as { id?: unknown; type?: unknown } | undefined;
  if (entity?.type !== "comment" || typeof entity.id !== "string") return null;
  const data = e.data as { page_id?: unknown; parent?: { type?: unknown } } | undefined;
  if (data?.parent?.type !== "page") return null;
  if (typeof data.page_id !== "string") return null;
  const authors = Array.isArray(e.authors) ? (e.authors as { id?: unknown; type?: unknown }[]) : [];
  if (authors.length !== 1) return null;
  const author = authors[0];
  if (typeof author?.id !== "string" || typeof author?.type !== "string") return null;
  const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  return {
    id: e.id,
    type,
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
    commentId: entity.id,
    pageId: data.page_id,
    authorId: author.id,
    authorType: author.type,
  };
}

async function fetchNotionComment(commentId: string): Promise<{ text: string } | null> {
  try {
    const res = await notionFetch(`/comments/${commentId}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { rich_text?: unknown };
    return { text: richTextToPlain(body.rich_text) };
  } catch {
    return null;
  }
}

/**
 * 处理一条 webhook 事件。返回值：
 * - "handled"：处理完成
 * - "ignored"：不属于本系统的事件（bot、块评论、非本站文章、重复投递）
 * - "retry"：暂时失败，路由应回 500 让 Notion 重试
 */
export async function handleNotionCommentEvent(raw: unknown): Promise<"handled" | "ignored" | "retry"> {
  const event = parseNotionEvent(raw);
  if (!event) return "ignored";
  if (Date.now() - event.timestamp > 10 * 60 * 1000) return "ignored";
  // 只认作者本人；bot 就是我们自己同步过去的那条，必须忽略，否则会循环
  if (event.authorType !== "person") return "ignored";
  const owners = await ownerIds();
  if (!owners.has(event.authorId)) return "ignored";

  const diaries = await getCachedDiaries();
  if (!diaries || !diaries.some((d) => d.id === event.pageId)) return "ignored";

  const redis = redisOrNull();
  if (!redis) return "retry";

  // 事件级去重：Notion 会把同一事件重试多次
  try {
    const fresh = await redis.set(EVENT_PREFIX + event.id, "1", { nx: true, ex: EVENT_TTL_S });
    if (fresh !== "OK") return "ignored";
  } catch {
    return "retry";
  }

  const mappingKey = MAPPING_PREFIX + event.commentId;

  if (event.type === "comment.deleted") {
    let commentId: string | null = null;
    try {
      const mapped = await redis.get<string>(mappingKey);
      if (typeof mapped === "string" && mapped !== "deleted") commentId = mapped;
    } catch {
      return "retry";
    }
    if (!commentId) return "ignored";
    await deleteComment(event.pageId, commentId);
    try {
      await redis.set(mappingKey, "deleted", { ex: TOMBSTONE_TTL_S });
    } catch {
      // 映射写失败不影响已经完成的删除
    }
    return "handled";
  }

  if (event.type === "comment.updated") {
    let commentId: string | null = null;
    try {
      const mapped = await redis.get<string>(mappingKey);
      if (typeof mapped === "string" && mapped !== "deleted") commentId = mapped;
    } catch {
      return "retry";
    }
    if (!commentId) return "ignored";
    const fetched = await fetchNotionComment(event.commentId);
    if (!fetched) return "retry";
    const text = fetched.text.trim().slice(0, MAX_TEXT);
    if (!text) return "ignored";
    await updateCommentContent(event.pageId, commentId, text);
    return "handled";
  }

  // comment.created：先占住映射键。已存在（含删除后的 tombstone）或并发抢占失败都忽略，
  // 一次 SET NX 同时覆盖"重复投递"与"两个事件同时到达"两种情况，不必先 get 再 set。
  try {
    const lock = await redis.set(mappingKey, "pending", { nx: true, ex: 60 });
    if (lock !== "OK") return "ignored";
  } catch {
    return "retry";
  }

  const fetched = await fetchNotionComment(event.commentId);
  if (!fetched) {
    try {
      const redis2 = redisOrNull();
      if (redis2) await redis2.del(mappingKey);
    } catch {
      // 留给下一条事件重试
    }
    return "retry";
  }
  const content = fetched.text.trim().slice(0, MAX_TEXT);
  if (!content) {
    await redis.del(mappingKey);
    return "ignored";
  }

  try {
    const profile = await getProfile();
    const created = await addComment({
      diaryId: event.pageId,
      author: profile.name,
      content,
      isAuthor: true,
      notionCommentId: event.commentId,
    });
    await redis.set(mappingKey, created.id);
    return "handled";
  } catch {
    await redis.del(mappingKey);
    return "retry";
  }
}

// ---------------------------------------------------------------------------
// 待补队列
// ---------------------------------------------------------------------------

/** 处理到期的待补任务；返回处理条数 */
export async function drainPending(max = 20): Promise<number> {
  const redis = redisOrNull();
  if (!redis || !isCommentSyncConfigured()) return 0;
  let members: unknown;
  try {
    members = await redis.zrange(PENDING_KEY, 0, Date.now(), { byScore: true, offset: 0, count: max });
  } catch {
    return 0;
  }
  if (!Array.isArray(members)) return 0;
  let done = 0;
  for (const member of members) {
    const raw = typeof member === "string" ? member : null;
    if (!raw) continue;
    let item: SyncPending;
    try {
      item = JSON.parse(raw) as SyncPending;
    } catch {
      await redis.zrem(PENDING_KEY, raw);
      continue;
    }
    const ok = await runPending(item);
    if (ok) {
      await redis.zrem(PENDING_KEY, raw);
      done += 1;
      continue;
    }
    if (item.attempts + 1 >= MAX_ATTEMPTS) {
      await redis.zrem(PENDING_KEY, raw);
      console.warn(`[comment-sync] 放弃待补任务 action=${item.action} comment=${item.commentId}`);
      continue;
    }
    await redis.zrem(PENDING_KEY, raw);
    await enqueue({ action: item.action, diaryId: item.diaryId, commentId: item.commentId, notionCommentId: item.notionCommentId }, item.attempts + 1);
  }
  return done;
}

async function runPending(item: SyncPending): Promise<boolean> {
  if (item.action === "create") {
    const comment = await getComment(item.diaryId, item.commentId);
    if (!comment) return true; // 评论已经没了，任务作废
    if (comment.notionCommentId) return true;
    const notionId = await createNotionComment(item.diaryId, buildCommentText(comment, (await getProfile()).name));
    if (!notionId) return false;
    const ok = await setNotionCommentId(item.diaryId, item.commentId, notionId);
    if (!ok) {
      await deleteNotionComment(notionId);
      return false;
    }
    const redis = redisOrNull();
    if (redis) {
      try {
        await redis.set(MAPPING_PREFIX + notionId, item.commentId);
      } catch {
        // 映射失败下次重试会重复创建，先接受；概率低
      }
    }
    return true;
  }
  if (!item.notionCommentId) return true;
  const ok = await deleteNotionComment(item.notionCommentId);
  if (ok) {
    const redis = redisOrNull();
    if (redis) {
      try {
        await redis.set(MAPPING_PREFIX + item.notionCommentId, "deleted", { ex: TOMBSTONE_TTL_S });
      } catch {
        // 同上
      }
    }
  }
  return ok;
}
