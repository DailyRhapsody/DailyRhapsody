import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type { Comment } from "@/components/entries/types";

/**
 * 前端按批取评论线程。宽屏下每篇有评论的文章都在右侧显示线程，逐篇请求在评论多了以后会撞上
 * comments:list（40 次/分）与全局限流，超限记违规、累计会封 IP。所以：
 * - 线程挂上时先登记为候选；某篇真要显示时，同一请求顺带取回其他尚未缓存的候选（每批最多 20 篇）
 * - 两次请求至少间隔 2 秒（每分钟不超过 30 次）
 * - 结果缓存一分钟，切 tab、切筛选、跨 1440px 断点导致重挂载时不重复请求；缓存只在读到服务端
 *   数据或本地发表 / 删除时更新，命中缓存不续期
 */
const BATCH_MAX = 20;
const BATCH_DELAY_MS = 60;
const MIN_INTERVAL_MS = 2000;
const CACHE_TTL_MS = 60_000;

type Waiter = { resolve: (list: Comment[]) => void; reject: (err: unknown) => void };

const cache = new Map<string, { at: number; list: Comment[] }>();
/** 等某篇线程的调用方；在途的篇目不重复请求，结果回来一起通知 */
const waiting = new Map<string, Waiter[]>();
/** 需要发请求的篇目（有人在等、且不在途） */
const queue = new Set<string>();
const candidates = new Set<string>();
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let lastFlushAt = 0;

function fresh(id: string): boolean {
  const hit = cache.get(id);
  return !!hit && Date.now() - hit.at < CACHE_TTL_MS;
}

function schedule() {
  if (timer || queue.size === 0) return;
  const wait = Math.max(BATCH_DELAY_MS, lastFlushAt + MIN_INTERVAL_MS - Date.now());
  timer = setTimeout(flush, wait);
}

function settle(id: string, result: { list: Comment[] } | { err: unknown }) {
  const waiters = waiting.get(id) ?? [];
  waiting.delete(id);
  for (const w of waiters) {
    if ("list" in result) w.resolve(result.list);
    else w.reject(result.err);
  }
}

function flush() {
  timer = null;
  lastFlushAt = Date.now();
  const ids = [...queue].slice(0, BATCH_MAX);
  for (const id of ids) queue.delete(id);
  // 空位捎带其他候选篇，滚动时不必一篇一个请求
  for (const id of candidates) {
    if (ids.length >= BATCH_MAX) break;
    if (!ids.includes(id) && !inFlight.has(id) && !fresh(id)) ids.push(id);
  }
  for (const id of ids) inFlight.add(id);
  fetchWithTimeout(`/api/diaries/comments?ids=${ids.map(encodeURIComponent).join(",")}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data: { threads?: Record<string, Comment[]>; pending?: string[] }) => {
      const now = Date.now();
      const pending = new Set(Array.isArray(data?.pending) ? data.pending : []);
      for (const id of ids) {
        inFlight.delete(id);
        if (pending.has(id)) {
          // 响应体积到顶没放进去：有人等的重新排队，候选的下次再捎带
          if (waiting.has(id)) queue.add(id);
          continue;
        }
        const list = Array.isArray(data?.threads?.[id]) ? data.threads[id] : [];
        cache.set(id, { at: now, list });
        settle(id, { list });
      }
    })
    .catch((err) => {
      for (const id of ids) {
        inFlight.delete(id);
        settle(id, { err });
      }
    })
    .finally(schedule);
}

export function loadCommentThread(diaryId: string, { force = false } = {}): Promise<Comment[]> {
  const hit = cache.get(diaryId);
  if (!force && hit && fresh(diaryId)) return Promise.resolve(hit.list);
  return new Promise((resolve, reject) => {
    waiting.set(diaryId, [...(waiting.get(diaryId) ?? []), { resolve, reject }]);
    if (!inFlight.has(diaryId)) {
      queue.add(diaryId);
      schedule();
    }
  });
}

/** 线程挂上（有评论、还没到视口）时登记，下次请求顺带取回；卸载时注销 */
export function registerCommentThread(diaryId: string): () => void {
  candidates.add(diaryId);
  return () => {
    candidates.delete(diaryId);
  };
}

/** 本地发表 / 删除后写回缓存，重挂载时读到的是最新线程 */
export function updateCachedThread(diaryId: string, list: Comment[]) {
  cache.set(diaryId, { at: Date.now(), list });
}
