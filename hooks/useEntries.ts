"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { PAGE_SIZE } from "@/components/entries/utils";
import { scrollToEntry } from "@/components/entries/ScrollTimeline";
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
 * 3. hash 深链：URL 带 #entry-123 时如果文章不在当前页就一直翻页直到拉到，滚到一次后
 *    不再响应该锚点；目标不在当前筛选的大纲里则不翻页
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
  /** hash 深链落地滚动的中止函数（scrollToEntry 返回）。时间轴跳转或切 tag 接管、gate 重拉
   *  卸载卡片、组件卸载时中止，否则两段逐帧滚动互相争抢，或追着已移出 DOM 的卡片把页面往上带。 */
  const hashScrollStopRef = useRef<(() => void) | null>(null);
  /** 真正落地过的 hash 深链（锚点 + 当时的 tag）。gate 重拉卸载卡片、页面缩回顶部后据此重新定位；
   *  读者之后切 tag、点时间轴、打断落地动画，就不再恢复。 */
  const hashLandedRef = useRef<{ anchor: string; tag: string | null } | null>(null);
  const requestEntry = useCallback((id: string | null) => {
    // 时间轴跳转 / 切 tag 接管页面滚动：先停掉还在进行的 hash 深链落地，读者已离开那篇
    hashScrollStopRef.current?.();
    hashLandedRef.current = null;
    setPendingEntryId(id);
  }, []);
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
  /**
   * 已了结的 hash 深链锚点：已滚到过，或读者已离开（回顶、切去动态 tab）。地址栏的
   * #entry- 会一直留着，不记下来的话此后每次翻页 append 都会重跑深链 effect，
   * 把读者拉回分享的那篇。只在 gate 就绪重拉冲掉刚落地的位置时清掉（见 hashLandedRef）。
   */
  const hashHandledRef = useRef<string | null>(null);

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
  /** 上一次首页加载对应的 gateGen：区分「gate 就绪重拉」与快速来回切 tag 造成的同 tag 重拉 */
  const lastGateGenRef = useRef(gateGen);
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
    const gateReload = lastGateGenRef.current !== gateGen;
    lastGateGenRef.current = gateGen;
    // gate 就绪重拉（新标签页打开分享链接时握手完成会来一次）期间 loading 为真、卡片全部卸载，
    // 页面缩回顶部，刚落地的位置随之丢失。同一 tag 下真正落地、之后读者没再操作过（切 tag、
    // 点时间轴、打断落地）的那次，重拉结束后清掉「已了结」让深链重新定位；读者已离开的不恢复。
    const landed = hashLandedRef.current;
    const relocate =
      gateReload && landed !== null && landed.tag === selectedTag && hashHandledRef.current === landed.anchor;
    // 卡片即将卸载：还在进行的落地滚动随之作废，免得追着脱离 DOM 的卡片把页面往上带
    if (relocate) hashScrollStopRef.current?.();
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
        if (ctrl.signal.aborted) return;
        // 成功或同 tag 失败保留旧数据都会重新渲染卡片，此时再放开深链
        if (relocate) {
          hashHandledRef.current = null;
          hashLandedRef.current = null;
        }
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [selectedTag, loadPage, gateGen]);

  /* 同页 hash 跳转（例如数字人回复里的文章链接）不会重载页面：递增一下让深链 effect
   * 立即处理新锚点，否则要等下一次翻页才生效，把读者从当前位置拉回去 */
  const [hashGen, setHashGen] = useState(0);
  useEffect(() => {
    const onHashChange = () => setHashGen((g) => g + 1);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /* ── hash 深链 #entry-N / 时间轴跳转：目标文章不在已加载列表里时逐页 append ──
   * 时间轴跳转（pendingEntryId）只负责补页，加载到后的滚动由时间轴自己做。 */
  useEffect(() => {
    if (loading || typeof window === "undefined") return;
    const anchor = pendingEntryId
      ? `entry-${pendingEntryId}`
      : window.location.hash.replace(/^#/, "");
    if (!anchor.startsWith("entry-")) return;
    // hash 深链只滚一次：之后翻页 append 重跑本 effect 时不再把读者拉回分享的那篇
    if (!pendingEntryId && hashHandledRef.current === anchor) return;
    const el = document.getElementById(anchor);
    if (el) {
      if (pendingEntryId) return;
      hashHandledRef.current = anchor;
      // 读者正在用顶栏回顶：尊重读者，放弃这次定位，不和回顶动画争抢滚动
      if (document.documentElement.dataset.returnToTop) return;
      // 不用原生 smooth scrollIntoView：首屏翻转动画（rotateX）期间按变形后的几何
      // 算落点，会停在半路或根本不滚；scrollToEntry 逐帧跟随目标实时位置并在结束后校正
      hashScrollStopRef.current?.();
      const landing = { anchor, tag: selectedTag };
      hashLandedRef.current = landing;
      hashScrollStopRef.current = scrollToEntry(el, (completed) => {
        // 读者滚轮/触摸/按键打断了落地：算读者已接管，gate 重拉时不再恢复
        if (!completed && hashLandedRef.current === landing) hashLandedRef.current = null;
      });
      return;
    }
    const targetId = anchor.slice("entry-".length);
    if (!targetId) return;
    // 已加载但卡片不在 DOM：补页期间读者切去了动态 tab。视为读者已离开、不再定位，
    // 否则切回博客后的下一次翻页会重跑本 effect，把读者拉回这篇
    if (items.some((d) => d.id === targetId)) {
      if (!pendingEntryId) hashHandledRef.current = anchor;
      return;
    }
    // hash 目标不在当前筛选的大纲里（切到不含它的 tag、或文章已删/转私密）：翻完也
    // 找不到，不为它翻页。不记为已处理——切回包含它的筛选时照常定位。
    // 须确认大纲属于当前 tag：切 tag 的那次提交里首页请求还没发出，大纲仍是旧 tag 的。
    if (
      !pendingEntryId &&
      loadedTagRef.current === selectedTag &&
      !outline.some((o) => o.id === targetId)
    ) {
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
  }, [loading, items, outline, total, hasMore, loadingMore, selectedTag, loadPage, pendingEntryId, appendRetryGen, hashGen]);

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

  /* ── 卸载时中止在途 append 与深链落地滚动、清理分页恢复定时器 ── */
  useEffect(() => {
    return () => {
      appendCtrlRef.current?.abort();
      appendCtrlRef.current = null;
      hashScrollStopRef.current?.();
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
