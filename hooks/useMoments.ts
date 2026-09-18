"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type { MomentOutlineItem, PublicMoment } from "@/components/entries/types";

const PAGE_LIMIT = 8;
/** 提前 240px 触发加载下一页，避免动态滚动到底再 stall */
const SCROLL_ROOT_MARGIN = "240px";

export type UseMomentsState = {
  moments: PublicMoment[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** 全部可见动态的大纲（含未加载的），供时间轴使用 */
  outline: MomentOutlineItem[];
  /** 时间轴请求跳转、但尚未加载到的动态 id */
  pendingMomentId: string | null;
  /** 请求逐页补载直到该动态出现；传 null 取消 */
  requestMoment: (id: string | null) => void;
};

/**
 * 拉 /api/moments 的分页 + 无限滚动逻辑。
 *
 * - 组件挂载时立刻拉首页（不论当前在哪个 tab，因为 entries 顶部缩略卡也要用 moments 数据）。
 * - 后续 IntersectionObserver 只在 active=true（即用户当前正看着动态 tab）时挂上，
 *   否则白白浪费一个 observer 持有 DOM 引用。
 *
 * 把这一坨从 page.tsx 抽出来主要是因为：state、ref、callback、两个 effect 互相耦合，
 * 留在 page 里会和文章列表 / tab 切换 / 彩蛋 / hash 深链等 7 个 effect 全部混在一个作用域。
 */
export function useMoments({ active }: { active: boolean }): UseMomentsState {
  const [moments, setMoments] = useState<PublicMoment[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [outline, setOutline] = useState<MomentOutlineItem[]>([]);
  const [pendingMomentId, setPendingMomentId] = useState<string | null>(null);
  const requestMoment = useCallback((id: string | null) => setPendingMomentId(id), []);

  const loadLock = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /**
   * 分页失败后的冷却截止时间戳。没有它，append 失败 → loadingMore 翻回 false →
   * observer 重建 → sentinel 仍在视窗 → 立即重试，形成请求自旋打满限流。
   */
  const appendCooldownUntilRef = useRef(0);
  /** 冷却到期后自增，触发 observer effect 重建以恢复分页（否则 sentinel 一直
   *  停在视窗内不会产生新 intersection 事件，分页会静默停摆）。 */
  const [appendRetryGen, setAppendRetryGen] = useState(0);
  const appendRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 在途 append 请求的 controller。生命周期跟随请求本身而不是 observer effect——
   * observer effect 因 loadingMore / offset 翻转会频繁重建，若在它的 cleanup 里
   * abort，每条 append 都会被自己触发的重建立刻取消。
   * 只在首屏换血（gate 重拉）与组件卸载时中止。
   */
  const appendCtrlRef = useRef<AbortController | null>(null);

  /** 返回 false 表示请求失败（被取消或被锁跳过都不算失败） */
  const loadPage = useCallback(async (fromOffset: number, replace: boolean, signal?: AbortSignal): Promise<boolean> => {
    if (replace) {
      setLoading(true);
    } else {
      // 防止 observer 在 setLoadingMore 还没 flush 时把同一 offset 又触发一次
      if (loadLock.current) return true;
      loadLock.current = true;
      setLoadingMore(true);
    }
    try {
      const res = await fetchWithTimeout(
        `/api/moments?limit=${PAGE_LIMIT}&offset=${fromOffset}${replace && fromOffset === 0 ? "&outline=1" : ""}`,
        { credentials: "include", signal },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(res.status));
      const next: PublicMoment[] = Array.isArray(data.items) ? data.items : [];
      setHasMore(!!data.hasMore);
      setOffset(typeof data.nextOffset === "number" ? data.nextOffset : fromOffset + next.length);
      if (replace) {
        setMoments(next);
        setOutline(Array.isArray(data.outline) ? data.outline : []);
      } else setMoments((prev) => [...prev, ...next]);
      return true;
    } catch {
      // 主动取消的请求（gate 重拉换血 / 卸载），不动任何 state
      if (signal?.aborted) return true;
      // 失败保留已有数据、不动 hasMore：不把「加载失败」渲染成空列表，
      // 恢复交给 gate 重拉或下面的冷却重试
      if (!replace) {
        // 冷却 5s：避免「失败 → observer 重建 → sentinel 仍在视窗 → 立即重试」
        // 的自旋打满限流
        appendCooldownUntilRef.current = Date.now() + 5000;
        // 冷却到期后 bump appendRetryGen 重建 observer 恢复分页——
        // sentinel 停在视窗内不会再产生 intersection 事件，不主动重建会静默停摆
        if (appendRetryTimerRef.current) clearTimeout(appendRetryTimerRef.current);
        appendRetryTimerRef.current = setTimeout(() => {
          appendRetryTimerRef.current = null;
          setAppendRetryGen((g) => g + 1);
        }, 5100);
      }
      return false;
    } finally {
      if (replace) {
        // 被换血取消的旧首屏请求不动 loading——新一轮已 setLoading(true)，
        // 这里再翻回 false 会把新一轮的 loading 态闪掉
        if (!signal?.aborted) setLoading(false);
      } else {
        setLoadingMore(false);
        loadLock.current = false;
      }
    }
  }, []);

  /* gate 就绪时重加载 */
  const [gateGen, setGateGen] = useState(0);
  useEffect(() => {
    const onGateReady = () => setGateGen((g) => g + 1);
    window.addEventListener("dr-gate-ready", onGateReady);
    return () => window.removeEventListener("dr-gate-ready", onGateReady);
  }, []);

  /* 首次拉取 + gate 就绪后重拉。
   * AbortController cleanup：gate 就绪触发二次执行时取消上一条 in-flight 请求，
   * 被取消的旧请求 reject 后绝不能再动 state——否则后失败的会把先成功的覆盖。 */
  useEffect(() => {
    const ctrl = new AbortController();
    // 换血重拉后列表整体重置，在途的旧 append 结果不能再接到新列表后面
    appendCtrlRef.current?.abort();
    appendCtrlRef.current = null;
    void loadPage(0, true, ctrl.signal);
    return () => ctrl.abort();
  }, [loadPage, gateGen]);

  /* 无限滚动：仅在动态 tab 激活时挂 IntersectionObserver */
  useEffect(() => {
    if (!active) return;
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || loadingMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingMore) return;
        if (Date.now() < appendCooldownUntilRef.current) return;
        // 已有在途 append 时不进入，避免把它的 controller 从 appendCtrlRef 顶掉
        if (loadLock.current) return;
        const ctrl = new AbortController();
        appendCtrlRef.current = ctrl;
        void loadPage(offset, false, ctrl.signal).finally(() => {
          if (appendCtrlRef.current === ctrl) appendCtrlRef.current = null;
        });
      },
      { rootMargin: SCROLL_ROOT_MARGIN, threshold: 0 },
    );
    obs.observe(el);
    // cleanup 只拆 observer，不 abort 在途 append（见 appendCtrlRef 注释）；
    // 恢复定时器也不在这里清理——本 effect 频繁重建，若随 cleanup 清掉，
    // 失败后刚设的定时器会立即被下一次重建清除，恢复机制失效。
    return () => obs.disconnect();
  }, [active, hasMore, loading, loadingMore, offset, loadPage, appendRetryGen]);

  /* 时间轴跳转：目标动态未加载时逐页补载；失败即放弃，冷却期内到期后重试一次 */
  useEffect(() => {
    if (!pendingMomentId || loading || loadingMore || !hasMore) return;
    if (moments.some((m) => String(m.id) === pendingMomentId)) return;
    if (loadLock.current) return;
    const cooldownLeft = appendCooldownUntilRef.current - Date.now();
    if (cooldownLeft > 0) {
      const t = setTimeout(() => setAppendRetryGen((g) => g + 1), cooldownLeft + 50);
      return () => clearTimeout(t);
    }
    const target = pendingMomentId;
    const ctrl = new AbortController();
    appendCtrlRef.current = ctrl;
    void loadPage(offset, false, ctrl.signal).then((ok) => {
      if (appendCtrlRef.current === ctrl) appendCtrlRef.current = null;
      if (!ok) setPendingMomentId((cur) => (cur === target ? null : cur));
    });
    // 不在 cleanup 里 abort（见 appendCtrlRef 注释）
  }, [pendingMomentId, moments, loading, loadingMore, hasMore, offset, loadPage, appendRetryGen]);

  /* 卸载时中止在途 append、清理分页恢复定时器 */
  useEffect(() => {
    return () => {
      appendCtrlRef.current?.abort();
      appendCtrlRef.current = null;
      if (appendRetryTimerRef.current) {
        clearTimeout(appendRetryTimerRef.current);
        appendRetryTimerRef.current = null;
      }
    };
  }, []);

  return { moments, hasMore, loading, loadingMore, sentinelRef, outline, pendingMomentId, requestMoment };
}
