import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type { Comment } from "@/components/entries/types";

/**
 * 前端按批取评论线程：同一时刻进入视口附近的几篇攒成一个请求（最多 20 篇），
 * 结果缓存一分钟，切 tab、切筛选、跨 1440px 断点导致线程重挂载时不重复请求。
 * 逐篇请求在评论多了以后会撞上 comments:list（40 次/分）与全局限流，超限记违规、累计会封 IP。
 */
const BATCH_MAX = 20;
const BATCH_DELAY_MS = 60;
const CACHE_TTL_MS = 60_000;

type Waiter = { resolve: (list: Comment[]) => void; reject: (err: unknown) => void };

const cache = new Map<string, { at: number; list: Comment[] }>();
const queue = new Map<string, Waiter[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (timer || queue.size === 0) return;
  timer = setTimeout(flush, BATCH_DELAY_MS);
}

function flush() {
  timer = null;
  const batch = [...queue.entries()].slice(0, BATCH_MAX);
  for (const [id] of batch) queue.delete(id);
  const ids = batch.map(([id]) => id);
  fetchWithTimeout(`/api/diaries/comments?ids=${ids.map(encodeURIComponent).join(",")}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data: { threads?: Record<string, Comment[]> }) => {
      const now = Date.now();
      for (const [id, waiters] of batch) {
        const list = Array.isArray(data?.threads?.[id]) ? data.threads[id] : [];
        cache.set(id, { at: now, list });
        for (const w of waiters) w.resolve(list);
      }
    })
    .catch((err) => {
      for (const [, waiters] of batch) for (const w of waiters) w.reject(err);
    })
    .finally(schedule);
}

export function loadCommentThread(diaryId: string, { fresh = false } = {}): Promise<Comment[]> {
  const hit = cache.get(diaryId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.list);
  return new Promise((resolve, reject) => {
    const waiters = queue.get(diaryId) ?? [];
    waiters.push({ resolve, reject });
    queue.set(diaryId, waiters);
    schedule();
  });
}

/** 发表 / 删除后把本地结果写回缓存，重挂载时不会读到旧线程 */
export function updateCachedThread(diaryId: string, list: Comment[]) {
  cache.set(diaryId, { at: Date.now(), list });
}
