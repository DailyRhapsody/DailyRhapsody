"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

const PAGE_SIZE = 30;

export type ReferenceListItem = {
  id: string;
  name: string;
  url: string;
  source: string;
  tags: string[];
  clippedAt: string;
  isPublic: boolean;
  kind: "external" | "commentary" | "test" | "interview";
  domains: string[];
  year: number | null;
  summary: string;
  license: "own" | "authorized" | "public" | "link-only";
  copyright: string;
  coverPath: string | null;
  coverKind: "file" | "external" | null;
  attachment: { kind: "file" | "external"; name: string; url?: string } | null;
};

type ReferenceListResponse = {
  items?: ReferenceListItem[];
  total?: number;
  hasMore?: boolean;
  tagCounts?: { name: string; value: number }[];
};

export type UseReferenceState = {
  items: ReferenceListItem[];
  total: number;
  tagCounts: { name: string; value: number }[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  maxTagCount: number;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
};

/**
 * /reference 列表的数据层。仿 useEntries 的最简版本：
 *  - 首屏 / 切 tag / dr-gate-ready 后从头拉一页
 *  - sentinel 进入视窗 → append 下一页
 *  - 不做日历热力图、彩蛋、hash 深链（reference 没有这些需求）
 */
export function useReference(
  selectedTag: string | null,
  initial?: {
    items: ReferenceListItem[];
    total: number;
    tagCounts: { name: string; value: number }[];
  },
): UseReferenceState {
  const [items, setItems] = useState<ReferenceListItem[]>(initial?.items ?? []);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [tagCounts, setTagCounts] = useState<{ name: string; value: number }[]>(
    initial?.tagCounts ?? [],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  /** 首屏数据由服务端给过：挂载时不要再打一次 /api/reference，否则 SSR 白做。
   *  空列表不算「给过」——缓存冷时服务端可能只回空态，仍需客户端走 gate 补拉。 */
  const skipHydrationFetchRef = useRef(Boolean(initial?.items.length));

  /* ── gate 就绪时的重加载触发器 ── */
  const [gateGen, setGateGen] = useState(0);
  useEffect(() => {
    const onGateReady = () => setGateGen((g) => g + 1);
    window.addEventListener("dr-gate-ready", onGateReady);
    return () => window.removeEventListener("dr-gate-ready", onGateReady);
  }, []);

  /**
   * loading 不用独立 state：它完全可以从「当前想要的请求」与「已完成的请求」之差派生。
   * 这样 effect body 里不需要同步 setState（react-hooks/set-state-in-effect），
   * 也避免了切 tag 时先渲染一帧旧数据、再翻转 loading 的级联渲染。
   */
  const [loadedKey, setLoadedKey] = useState<string | null>(
    initial ? `${selectedTag ?? ""}#0` : null,
  );
  const requestKey = `${selectedTag ?? ""}#${gateGen}`;
  const loading = loadedKey !== requestKey;

  const sentinelRef = useRef<HTMLDivElement>(null);
  const appendInFlightRef = useRef(false);
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
   * observer effect 因 loadingMore / items.length 翻转会频繁重建，若在它的
   * cleanup 里 abort，每条 append 都会被自己触发的重建立刻取消。
   * 只在首屏换血（切 tag / gate 重拉）与组件卸载时中止。
   */
  const appendCtrlRef = useRef<AbortController | null>(null);
  /**
   * 当前 items 实际归属的 tag（首页请求成功时写入）。失败时用它区分两种场景：
   * - 切到新 tag 后首页失败 → 必须清空（否则显示「tag B 共 N 条」+ tag A 的列表，
   *   一滚动还会把 B 的下一页追加到 A 的数据后面，跨 tag 混排）；
   * - 同 tag 刷新失败（gate 就绪重拉）→ 保留旧数据，不把「加载失败」渲染成「暂无收藏」。
   */
  const loadedTagRef = useRef<string | null | undefined>(
    initial ? selectedTag : undefined,
  );

  const hasMore = items.length < total && total > 0;
  const maxTagCount = tagCounts[0]?.value ?? 1;

  const loadPage = useCallback(
    (offset: number, append: boolean, tag: string | null, signal?: AbortSignal) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (tag) params.set("tag", tag);
      return fetchWithTimeout(`/api/reference?${params}`, { signal })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.json();
        })
        .then((data: ReferenceListResponse) => {
          const list = Array.isArray(data.items) ? data.items : [];
          if (append) setItems((prev) => [...prev, ...list]);
          else {
            setItems(list);
            loadedTagRef.current = tag; // items 从此归属这个 tag
          }
          if (typeof data.total === "number") setTotal(data.total);
          if (Array.isArray(data.tagCounts)) setTagCounts(data.tagCounts);
        });
    },
    [],
  );

  /* ── 首屏 / 切 tag / gate 就绪：从头拉一页 ──
   * AbortController cleanup：gate 就绪或切 tag 触发二次执行时取消上一条
   * in-flight 请求；被取消的旧请求 reject 后绝不能再动 state——否则后失败的
   * 会把先成功的清空。catch 的清空策略见 loadedTagRef 注释：只在「切到新 tag
   * 后首页失败」时清空，同 tag 刷新失败保留旧数据，「加载失败」不再被渲染成
   * 「暂无收藏」。 */
  useEffect(() => {
    // 首屏数据已经由 server component 塞进来：跳过挂载时的重复请求。
    // 后续切 tag、gate 就绪重拉照常走下面的逻辑。
    if (skipHydrationFetchRef.current) {
      skipHydrationFetchRef.current = false;
      return;
    }
    const ctrl = new AbortController();
    // 首屏换血后列表整体重置，在途的旧 append 结果不能再接到新列表后面
    appendCtrlRef.current?.abort();
    appendCtrlRef.current = null;
    loadPage(0, false, selectedTag, ctrl.signal)
      .catch(() => {
        // 本 effect 自己取消的请求（cleanup / gate 二次触发），不动任何 state
        if (ctrl.signal.aborted) return;
        // tagCounts 是全站维度、与 tag 筛选无关，保留。
        if (loadedTagRef.current !== selectedTag) {
          setItems([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoadedKey(requestKey);
      });
    return () => ctrl.abort();
  }, [selectedTag, loadPage, requestKey]);

  /* ── 无限滚动：sentinel 进视窗就 append ── */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (
          !entries[0]?.isIntersecting ||
          loadingMore ||
          appendInFlightRef.current
        )
          return;
        if (Date.now() < appendCooldownUntilRef.current) return;
        // items 尚未归属当前 tag（首页在途/失败）时不允许 append，防跨 tag 混排
        if (loadedTagRef.current !== selectedTag) return;
        const ctrl = new AbortController();
        appendCtrlRef.current = ctrl;
        appendInFlightRef.current = true;
        setLoadingMore(true);
        const offset = items.length;
        loadPage(offset, true, selectedTag, ctrl.signal)
          .catch(() => {
            if (ctrl.signal.aborted) return; // 首屏换血/卸载时主动取消的，不计失败
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
          })
          .finally(() => {
            if (appendCtrlRef.current === ctrl) appendCtrlRef.current = null;
            appendInFlightRef.current = false;
            setLoadingMore(false);
          });
      },
      { rootMargin: "200px", threshold: 0 },
    );
    obs.observe(el);
    // 注意：cleanup 只拆 observer，不 abort 在途 append（见 appendCtrlRef 注释）；
    // 恢复定时器也不在这里清理——本 effect 因 loadingMore 翻转而频繁重建，
    // 若随 cleanup 清掉，失败后刚设的定时器会立即被下一次重建清除，恢复机制失效。
    return () => obs.disconnect();
  }, [hasMore, loading, loadingMore, items.length, selectedTag, loadPage, appendRetryGen]);

  /* ── 卸载时中止在途 append、清理分页恢复定时器 ── */
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

  return useMemo(
    () => ({
      items,
      total,
      tagCounts,
      loading,
      loadingMore,
      hasMore,
      maxTagCount,
      sentinelRef,
    }),
    [items, total, tagCounts, loading, loadingMore, hasMore, maxTagCount],
  );
}
