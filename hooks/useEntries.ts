"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { PAGE_SIZE } from "@/components/entries/utils";
import type { Diary, EntryOutlineItem } from "@/components/entries/types";

type DiariesResponse = {
  items?: Diary[];
  total?: number;
  tagCounts?: { name: string; value: number }[];
  dates?: string[];
  outline?: EntryOutlineItem[];
};

export type UseEntriesState = {
  /** 当前已加载的文章列表 */
  items: Diary[];
  /** 后端返回的总篇数（用于「篇文章」卡片 + 是否还有下一页判定） */
  total: number;
  /** 标签词云数据，按出现次数倒序 */
  tagCounts: { name: string; value: number }[];
  /** 首屏 / 切标签时的 loading；分页 append 时不会拉起这个 */
  loading: boolean;
  /** 分页 append loading */
  loadingMore: boolean;
  /** 是否还有下一页（items.length < total） */
  hasMore: boolean;
  /** 当前最大 tag 计数，用于词云字号映射 */
  maxTagCount: number;
  /** 后端返回的所有有发文的日期，用于日历热力图 */
  datesWithPosts: Set<string>;
  /** 本月发文篇数（来自 datesWithPosts） */
  thisMonthPostCount: number;
  /** 文章列表底部 sentinel 的回调 ref，挂在 IntersectionObserver 上做无限滚动 */
  sentinelRef: React.RefCallback<HTMLDivElement>;
  /** 当前筛选下全部文章的大纲（含未加载的），供时间轴使用 */
  outline: EntryOutlineItem[];
  /** 时间轴请求跳转、但尚未加载到的文章 id */
  pendingEntryId: string | null;
  /** 请求逐页补载直到该文章出现；传 null 取消 */
  requestEntry: (id: string | null) => void;
};

/**
 * 文章列表 + 标签 + 热力图所需的全部数据层。
 *
 * 会做四件事：
 * 1. 首屏加载：组件挂载或 selectedTag 切换时拉首页
 * 2. 无限滚动：sentinel 进入视窗时 append 下一页
 * 3. hash 深链：URL 带 #entry-123 时如果文章不在当前页就一直翻页直到拉到（或翻完）
 * 4. 把 dates / tagCounts 派生成 datesWithPosts / thisMonthPostCount / maxTagCount
 *
 * 之前这些状态、callback、4 个 effect 全在 entries page 里和彩蛋、tab 切换、滚动同步混在
 * 一起；抽出来后调用方只需要 `const { items, ... } = useEntries(selectedTag)` 一行。
 */
export function useEntries(selectedTag: string | null): UseEntriesState {
  const [items, setItems] = useState<Diary[]>([]);
  const [total, setTotal] = useState(0);
  const [tagCounts, setTagCounts] = useState<{ name: string; value: number }[]>([]);
  const [datesFromApi, setDatesFromApi] = useState<string[]>([]);
  const [outline, setOutline] = useState<EntryOutlineItem[]>([]);
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const requestEntry = useCallback((id: string | null) => setPendingEntryId(id), []);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * sentinel 节点存 state 而不是 useRef：切到「动态」tab 时整个博客列表（含 sentinel）
   * 卸载，切回来挂的是新节点。用 ref 的话 observer effect 的依赖一个都没变、不会重建，
   * observer 继续盯着已脱离文档的旧节点，无限滚动静默停摆。存 state 后节点一换就重建。
   */
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null);
  /** 防止「无限滚动 observer」与「hash 深链补页」同时触发同一 offset 的重复 append */
  const appendInFlightRef = useRef(false);
  /**
   * 分页失败后的冷却截止时间戳。没有它，append 失败 → loadingMore 翻回 false →
   * observer 重建 → sentinel 仍在视窗 → 立即重试，形成请求自旋；60 次就触发
   * diaries:list 限流，再 4 次违规即把自己的 IP 封 24 小时。
   */
  const appendCooldownUntilRef = useRef(0);
  /** 冷却到期后自增，触发 observer effect 重建以恢复分页（否则 sentinel 一直
   *  停在视窗内不会产生新 intersection 事件，分页会静默停摆）。 */
  const [appendRetryGen, setAppendRetryGen] = useState(0);
  const appendRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 在途 append 请求的 controller。生命周期跟随请求本身而不是发起它的 effect——
   * observer/hash effect 因 loadingMore、items 翻转会频繁重建，若在它们的
   * cleanup 里 abort，每条 append 都会被自己触发的重建立刻取消：catch 判为
   * 「主动取消」绕过冷却，finally 翻回 loadingMore 后 observer 重挂再发，
   * 形成请求风暴（2026-08-25 自封 IP 事故）。
   * 只在首屏换血（切 tag / gate 重拉）与组件卸载时中止。
   */
  const appendCtrlRef = useRef<AbortController | null>(null);
  /**
   * 当前 items 实际归属的 tag（首页请求成功时写入）。失败时用它区分两种场景：
   * - 切到新 tag 后首页失败 → 必须清空（否则显示「tag B 共 N 篇」+ tag A 的列表，
   *   一滚动还会把 B 的下一页追加到 A 的数据后面，跨 tag 混排）；
   * - 同 tag 刷新失败（gate 就绪重拉）→ 保留旧数据，不把「加载失败」渲染成「暂无文章」。
   */
  const loadedTagRef = useRef<string | null | undefined>(undefined);

  const hasMore = items.length < total && total > 0;

  const datesWithPosts = useMemo(() => new Set(datesFromApi), [datesFromApi]);
  const thisMonthPostCount = useMemo(() => {
    const now = new Date();
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let count = 0;
    datesWithPosts.forEach((d) => {
      if (d.startsWith(prefix)) count++;
    });
    return count;
  }, [datesWithPosts]);
  const maxTagCount = tagCounts[0]?.value ?? 1;

  const loadPage = useCallback(
    (offset: number, append: boolean, tag: string | null, signal?: AbortSignal) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (tag) params.set("tag", tag);
      if (!append) params.set("outline", "1");
      return fetchWithTimeout(`/api/diaries?${params}`, { signal })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.json();
        })
        .then((data: DiariesResponse) => {
          const list = Array.isArray(data.items) ? data.items : [];
          if (append) setItems((prev) => [...prev, ...list]);
          else {
            setItems(list);
            setOutline(Array.isArray(data.outline) ? data.outline : []);
            loadedTagRef.current = tag; // items 从此归属这个 tag
          }
          if (typeof data.total === "number") setTotal(data.total);
          if (Array.isArray(data.tagCounts)) setTagCounts(data.tagCounts);
          if (Array.isArray(data.dates)) setDatesFromApi(data.dates);
        });
    },
    [],
  );

  /* ── gate 就绪时的重加载触发器 ── */
  const [gateGen, setGateGen] = useState(0);
  useEffect(() => {
    const onGateReady = () => setGateGen((g) => g + 1);
    window.addEventListener("dr-gate-ready", onGateReady);
    return () => window.removeEventListener("dr-gate-ready", onGateReady);
  }, []);

  /* ── 首屏 / selectedTag 切换 / gate 就绪：从头拉一页 ──
   * AbortController cleanup 有两个作用：
   * 1. gateGen 自增（握手完成）触发二次执行时，取消上一条 in-flight 请求的
   *    客户端等待（服务端在途的那份会跑完，同实例由 ensureRefreshTask 合并；
   *    2026-08 事故中两条请求都活着且互相清 state，是放大器之一）。
   * 2. 被取消的旧请求 reject 后绝不能再动 state——否则后失败的会把先成功的清空。
   * catch 的清空策略见 loadedTagRef 注释：只在「切到新 tag 后首页失败」时清空，
   * 同 tag 刷新失败保留旧数据，「加载失败」不再被渲染成「暂无文章」。 */
  useEffect(() => {
    const ctrl = new AbortController();
    // 首屏换血后列表整体重置，在途的旧 append 结果不能再接到新列表后面
    appendCtrlRef.current?.abort();
    appendCtrlRef.current = null;
    setLoading(true);
    loadPage(0, false, selectedTag, ctrl.signal)
      .catch(() => {
        // 本 effect 自己取消的请求（cleanup / gate 二次触发），不动任何 state
        if (ctrl.signal.aborted) return;
        // 切到新 tag 后首页失败：清空，避免旧 tag 数据顶着新 tag 的名义展示
        // 并被后续分页混排；同 tag 刷新失败则保留旧数据（见 loadedTagRef 注释）。
        // tagCounts/dates 是全站维度、与 tag 筛选无关，保留。
        if (loadedTagRef.current !== selectedTag) {
          setItems([]);
          setTotal(0);
          setOutline([]);
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [selectedTag, loadPage, gateGen]);

  /* ── hash 深链 #entry-N / 时间轴跳转：目标文章不在已加载列表里时逐页 append ──
   * 时间轴跳转（pendingEntryId）只负责补页，加载到后的滚动由时间轴自己做。 */
  useEffect(() => {
    if (loading || typeof window === "undefined") return;
    const anchor = pendingEntryId
      ? `entry-${pendingEntryId}`
      : window.location.hash.replace(/^#/, "");
    if (!anchor.startsWith("entry-")) return;
    const el = document.getElementById(anchor);
    if (el) {
      if (pendingEntryId) return;
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      return;
    }
    const targetId = anchor.slice("entry-".length);
    if (!targetId) return;
    const inList = items.some((d) => d.id === targetId);
    if (inList) {
      if (pendingEntryId) return;
      requestAnimationFrame(() => {
        document.getElementById(anchor)?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      });
      return;
    }
    if (total > 0 && items.length >= total) return;
    if (!hasMore || loadingMore || appendInFlightRef.current) return;
    const cooldownLeft = appendCooldownUntilRef.current - Date.now();
    if (cooldownLeft > 0) {
      // 时间轴跳转撞上冷却：到期后重跑一次本 effect（hash 深链保持原行为，不重试）
      if (!pendingEntryId) return;
      const t = setTimeout(() => setAppendRetryGen((g) => g + 1), cooldownLeft + 50);
      return () => clearTimeout(t);
    }
    // items 尚未归属当前 tag（首页在途/失败）时不允许 append，防跨 tag 混排
    if (loadedTagRef.current !== selectedTag) return;
    const ctrl = new AbortController();
    appendCtrlRef.current = ctrl;
    appendInFlightRef.current = true;
    setLoadingMore(true);
    loadPage(items.length, true, selectedTag, ctrl.signal)
      .catch(() => {
        if (ctrl.signal.aborted) return; // 首屏换血/卸载时主动取消的，不计失败
        appendCooldownUntilRef.current = Date.now() + 5000;
        // 时间轴跳转失败即放弃，不随冷却自动重试
        setPendingEntryId((cur) => (cur === targetId ? null : cur));
      })
      .finally(() => {
        if (appendCtrlRef.current === ctrl) appendCtrlRef.current = null;
        appendInFlightRef.current = false;
        setLoadingMore(false);
      });
    // 不在 cleanup 里 abort：本 effect 因 loadingMore/items 变化而重建，
    // 若随 cleanup 中止会把刚发起的请求自己取消掉（见 appendCtrlRef 注释）。
  }, [loading, items, total, hasMore, loadingMore, selectedTag, loadPage, pendingEntryId, appendRetryGen]);

  /* ── 无限滚动：sentinel 进视窗就 append ── */
  useEffect(() => {
    const el = sentinelEl;
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
            // 的自旋打满限流（进而累计违规自封 IP）
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
    // 它们的生命周期跨 effect 重建，只在组件卸载时清理（见下面的 mount effect）。
    return () => obs.disconnect();
  }, [sentinelEl, hasMore, loading, loadingMore, items.length, selectedTag, loadPage, appendRetryGen]);

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

  return {
    items,
    total,
    tagCounts,
    loading,
    loadingMore,
    hasMore,
    maxTagCount,
    datesWithPosts,
    thisMonthPostCount,
    sentinelRef: setSentinelEl,
    outline,
    pendingEntryId,
    requestEntry,
  };
}
