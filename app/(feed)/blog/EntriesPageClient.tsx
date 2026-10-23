"use client";

import { useEffect, useMemo, useRef, useState, useCallback, type SetStateAction } from "react";
import { usePathname } from "next/navigation";
import RainbowBrushTrail from "@/components/RainbowBrushTrail";
import { VisitorWorldMap } from "@/components/entries/VisitorWorldMap";
import type { VisitorMapPoint } from "@/lib/visitor-map";
import ConfettiBurst from "@/components/ConfettiBurst";
import { MomentLightbox } from "@/components/entries/MomentLightbox";
import { EntryCard } from "@/components/entries/EntryCard";
import { ScrollTimeline } from "@/components/entries/ScrollTimeline";
import { CognitiveTreeOverlay } from "@/components/entries/CognitiveTreeOverlay";
import { entryTimelineRows, momentTimelineRows, referenceTimelineRows } from "@/components/entries/timelineRows";
import { MomentsTab } from "@/components/entries/MomentsTab";
import { getSizeClass } from "@/components/entries/utils";
import type { MomentsTimelineRow } from "@/components/entries/types";
import { useReference, type ReferenceListItem } from "@/hooks/useReference";
import { usePublishFeedStats } from "../FeedShell";
import { shouldPublishEntryStats } from "@/lib/feed-stats";
import ReferenceFeed from "../reference/ReferenceFeed";
import { pickReferenceTop } from "@/lib/reference-thumbs";
import { useProfile, type Profile } from "@/hooks/useProfile";
import { useAdminSession } from "@/hooks/useAdminSession";
import { useMoments } from "@/hooks/useMoments";
import { useTabSwipeNavigation } from "@/hooks/useTabSwipeNavigation";
import { useEntries } from "@/hooks/useEntries";
import { useEggPullToRefresh } from "@/hooks/useEggPullToRefresh";

// 修饰键点击（新标签页）打开的地址。文章用绝对地址：在 /moments 上用相对 hash 会落在动态 tab；
// 动态没有深链定位，只打开动态 tab
const entryHref = (id: string) => `/blog#entry-${id}`;
const momentHref = () => "/moments";
/** 顶部两个 tab 对应的地址：切 tab 时同步到地址栏，刷新、分享都落回同一个 tab */
const TAB_PATHS = ["/blog", "/moments", "/reference"] as const;
const ENTRY_MESSAGES = { loading: "正在载入更早的文章", failed: "未能载入这篇文章" };
const MOMENT_MESSAGES = { loading: "正在载入更早的动态", failed: "未能载入这条动态" };
const REFERENCE_MESSAGES = { loading: "正在载入更早的资料", failed: "未能载入这条资料" };
const referenceHref = (id: string) => `/reference/${id}`;

export default function EntriesPageClient({
  initialProfile,
  initialReferenceItems,
  initialReferenceTotal,
  initialReferenceTagCounts,
}: {
  initialProfile: Profile | null;
  initialReferenceItems?: ReferenceListItem[];
  initialReferenceTotal?: number;
  initialReferenceTagCounts?: { name: string; value: number }[];
}) {
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [referenceTag, setReferenceTag] = useState<string | null>(null);
  const {
    items,
    total,
    tagCounts,
    loading,
    firstPageLoaded,
    loadingMore,
    hasMore,
    maxTagCount,
    dateCounts,
    thisMonthPostCount,
    sentinelRef,
    outline,
    pendingEntryId,
    requestEntry,
  } = useEntries(selectedTag);
  const {
    items: referenceItems,
    total: referenceTotal,
    tagCounts: referenceTagCounts,
    loading: referenceLoading,
    loadingMore: referenceLoadingMore,
    hasMore: referenceHasMore,
    sentinelRef: referenceSentinelRef,
  } = useReference(
    referenceTag,
    initialReferenceItems
      ? {
          items: initialReferenceItems,
          total: initialReferenceTotal ?? initialReferenceItems.length,
          tagCounts: initialReferenceTagCounts ?? [],
        }
      : undefined,
  );
  const totalPosts = total;
  const currentEntries = items;

  /* ── 顶部 tab 以地址为唯一来源：/moments 是动态，其余是博客。
       切 tab 只用 replaceState 改地址栏（不重载、不新增历史记录），Next 会同步 usePathname，
       浏览器前进后退时也按该条历史的真实地址落回对应 tab ── */
  const pathname = usePathname();
  const activeTopTab =
    pathname === "/moments" ? 1 : pathname === "/reference" ? 2 : 0; // 0=博客, 1=动态, 2=参考
  const activeTabRef = useRef(activeTopTab);
  useEffect(() => {
    activeTabRef.current = activeTopTab;
  }, [activeTopTab]);
  const setActiveTopTab = useCallback((next: SetStateAction<number>) => {
    const current = activeTabRef.current;
    const raw = typeof next === "function" ? next(current) : next;
    const value = ((raw % 3) + 3) % 3;
    if (value === current) return;
    activeTabRef.current = value;
    const params = new URLSearchParams(window.location.search);
    params.delete("tab");
    const query = params.toString();
    // 博客的 #entry- 深链只在博客 tab 保留；切到动态/参考时去掉，免得回到博客后被拉回旧锚点
    const hash = value === 0 ? window.location.hash : "";
    window.history.replaceState(null, "", `${TAB_PATHS[value]}${query ? `?${query}` : ""}${hash}`);
  }, []);
  const {
    moments,
    hasMore: momentsHasMore,
    loading: momentsLoading,
    loadingMore: momentsLoadingMore,
    sentinelRef: momentsSentinelRef,
    outline: momentsOutline,
    pendingMomentId,
    requestMoment,
  } = useMoments({ active: activeTopTab === 1 });
  const [lightbox, setLightbox] = useState<{ urls: string[]; i: number; lbKey: string } | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const treeTargetRef = useRef<string | null>(null);
  const treeRequestedRef = useRef<string | null>(null);
  const profile = useProfile(initialProfile);
  const { isAdmin: isAdminSession } = useAdminSession();
  const [entriesFlipped, setEntriesFlipped] = useState(false);
  /* ── 底图访客点位：延后 1.2s 再取，避免和文章流抢首屏带宽；失败就只留地图，不显示光点。
        接口只返回格子级聚合点位（无 IP / 无城市名 / 无精确坐标），见 lib/visitor-map.ts ── */
  const [mapPoints, setMapPoints] = useState<VisitorMapPoint[] | null>(null);
  /** 彩蛋只有在「最后一页且已有内容」时才允许触发 */
  const { eggPullY, isRebounding } = useEggPullToRefresh(!hasMore && totalPosts > 0);
  const contentWrapperRef = useRef<HTMLDivElement>(null);

  // 时间轴数据：引用稳定（只随列表数据变化），ScrollTimeline 是 memo 组件
  const entryRows = useMemo(() => entryTimelineRows(outline), [outline]);
  const entryIds = useMemo(() => items.map((d) => d.id), [items]);
  const momentRows = useMemo(() => momentTimelineRows(momentsOutline), [momentsOutline]);
  const referenceRows = useMemo(() => referenceTimelineRows(referenceItems), [referenceItems]);
  const referenceIds = useMemo(() => referenceItems.map((r) => r.id), [referenceItems]);
  const referenceTop = useMemo(
    () => pickReferenceTop(referenceItems),
    [referenceItems],
  );
  // 与 MomentsTab 的渲染条件一致：没有图片/视频的动态不渲染，也不参与高亮定位
  const momentIds = useMemo(() => moments.filter((m) => m.media.length > 0).map((m) => String(m.id)), [moments]);

  const momentsTimeline = useMemo<MomentsTimelineRow[]>(() => {
    return moments.map((m) => ({
      rowKey: `moment-${m.id}`,
      createdAt: m.createdAt,
      moment: m,
    }));
  }, [moments]);

  const momentsThumbs = useMemo(() => {
    const items: { src: string; isVideo: boolean }[] = [];
    for (const row of momentsTimeline) {
      const m = row?.moment;
      if (!m || !Array.isArray(m.media)) continue;
      for (const md of m.media) {
        const src = (md?.url || md?.thumbUrl || "").trim();
        if (!src) continue;
        const isVideo = (md?.mediaType ?? "").startsWith("video/");
        items.push({ src, isVideo });
        if (items.length >= 4) break;
      }
      if (items.length >= 4) break;
    }
    return items.slice(0, 4);
  }, [momentsTimeline]);

  /**
   * 两条统计各按自己的数据源就绪：博客统计等首屏 2xx 落地（参考 tab 一律不写，
   * 见 shouldPublishEntryStats 的注释），动态缩略卡只在自己有数据时才覆盖，
   * 免得首帧的空数组把服务端快照清空。
   */
  usePublishFeedStats(
    shouldPublishEntryStats({ activeTopTab, loading, firstPageLoaded })
      ? { totalPosts, thisMonthPostCount, dateCounts }
      : {},
  );
  usePublishFeedStats(momentsThumbs.length > 0 ? { momentsThumbs } : {});
  usePublishFeedStats(
    referenceTotal > 0 || referenceTop.length > 0
      ? {
          ...(referenceTotal > 0 ? { referenceTotal } : {}),
          ...(referenceTop.length > 0 ? { referenceTop } : {}),
        }
      : {},
  );

  useEffect(() => {
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  /* ── 旧链接 /entries?tab=moments 跳转后地址里残留 tab 参数：只去掉它，
       utm 等其余查询串原样保留，访问统计要读 ── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("tab")) return;
    params.delete("tab");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setEntriesFlipped(true), 80);
    return () => clearTimeout(t);
  }, []);

  /* gate 握手完成前后各会跑一次：首屏这次多半拿不到 dr_gate（接口 403），
     握手完成后由 dr-gate-ready 再取一次。与 useEntries / useCommentCounts 的重拉写法一致。 */
  const [mapGateGen, setMapGateGen] = useState(0);
  useEffect(() => {
    const onGateReady = () => setMapGateGen((g) => g + 1);
    window.addEventListener("dr-gate-ready", onGateReady);
    return () => window.removeEventListener("dr-gate-ready", onGateReady);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        fetch("/api/analytics/visitor-map", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!cancelled && d && Array.isArray(d.points)) setMapPoints(d.points as VisitorMapPoint[]);
          })
          .catch(() => {});
      },
      mapGateGen === 0 ? 1200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mapGateGen]);

  /* ── 禁止复制：键盘、右键菜单的复制与剪切都拦下；输入框里（写评论）照常，
        「复制文章链接」走剪贴板接口或临时 textarea，不受影响 ── */
  useEffect(() => {
    const block = (e: ClipboardEvent) => {
      const el = e.target instanceof Element ? e.target : document.activeElement;
      if (el?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    document.addEventListener("copy", block);
    document.addEventListener("cut", block);
    return () => {
      document.removeEventListener("copy", block);
      document.removeEventListener("cut", block);
    };
  }, []);

  /* ── 横向滚轮 / 触屏左右滑动切 tab + 屏蔽浏览器自带的左右回退 ── */
  useTabSwipeNavigation(setActiveTopTab, { min: -1, max: 3, enabled: lightbox == null && !treeOpen });

  const handleTagClick = (tag: string) => {
    requestEntry(null);
    setSelectedTag((prev) => (prev === tag ? null : tag));
  };

  /* 树上的叶子点击：覆盖层收到 iframe 的消息后关闭，再定位到对应文章。
     目标文章还未加载时，复用时间轴的逐页补载入口。 */
  const scrollToTreeTarget = useCallback((id: string) => {
    const el = document.getElementById(`entry-${id}`);
    if (!el) return false;
    treeTargetRef.current = id;
    window.history.replaceState(null, "", `/blog#entry-${id}`);
    let attempts = 0;
    let cancelled = false;
    const cancel = () => { cancelled = true; cleanup(); };
    const cleanup = () => {
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("touchstart", cancel, true);
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("pointerdown", cancel, true);
    };
    window.addEventListener("wheel", cancel, { capture: true, passive: true });
    window.addEventListener("touchstart", cancel, { capture: true, passive: true });
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("pointerdown", cancel, true);
    const align = () => {
      if (cancelled) return;
      const rect = el.getBoundingClientRect();
      if (Math.abs(rect.top - 96) > 6) {
        window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - 96), behavior: "instant" });
      }
      attempts++;
      if (attempts < 60) window.setTimeout(align, 100);
      else {
        cleanup();
        if (treeTargetRef.current === id) treeTargetRef.current = null;
      }
    };
    align();
    return true;
  }, []);
  const handleTreeEntry = useCallback((id: string) => {
    setTreeOpen(false);
    treeTargetRef.current = id;
    treeRequestedRef.current = null;
    // 树展示的是全部公开文章；若当前正按标签筛选，先回到全量，避免目标不在大纲里
    if (selectedTag !== null) {
      setSelectedTag(null);
      return;
    }
    if (scrollToTreeTarget(id)) return;
    requestEntry(id);
  }, [requestEntry, scrollToTreeTarget, selectedTag]);

  useEffect(() => {
    const id = treeTargetRef.current;
    if (!id || loadingMore || selectedTag !== null) return;
    if (!document.getElementById(`entry-${id}`)) {
      // 一次点击只发起一次补页；失败时不自动重试，避免撞上 diaries:list 限流
      if (pendingEntryId !== id && treeRequestedRef.current !== id) {
        treeRequestedRef.current = id;
        requestEntry(id);
      }
      return;
    }
    treeRequestedRef.current = null;
    requestEntry(null);
    scrollToTreeTarget(id);
  }, [currentEntries, loadingMore, pendingEntryId, requestEntry, scrollToTreeTarget, selectedTag]);

  return (
    // 整页文字不可选中（输入框除外，访客写评论时照常能选）
    <div className="font-sans text-zinc-900 dark:text-zinc-50">
      <VisitorWorldMap points={mapPoints} />
      <RainbowBrushTrail />
      <ConfettiBurst />
      {/* 必须在 entries-flip-wrapper 之外：它的 perspective/transform 会让 fixed 相对 main 定位 */}
      {activeTopTab === 0 ? (
        <ScrollTimeline
          key={`entries:${selectedTag ?? ""}`}
          ariaLabel="文章时间轴"
          rows={entryRows}
          anchorPrefix="entry-"
          itemIds={entryIds}
          hasMore={hasMore}
          visible={entriesFlipped && !loading}
          pendingId={pendingEntryId}
          requestId={requestEntry}
          hrefFor={entryHref}
          messages={ENTRY_MESSAGES}
          onOpenTree={() => setTreeOpen(true)}
        />
      ) : activeTopTab === 1 ? (
        <ScrollTimeline
          key="moments"
          ariaLabel="动态时间轴"
          rows={momentRows}
          anchorPrefix="moment-"
          itemIds={momentIds}
          hasMore={momentsHasMore}
          visible={entriesFlipped && !momentsLoading}
          pendingId={pendingMomentId}
          requestId={requestMoment}
          hrefFor={momentHref}
          messages={MOMENT_MESSAGES}
        />
      ) : (
        <ScrollTimeline
          key="reference"
          ariaLabel="资料时间轴"
          rows={referenceRows}
          anchorPrefix="reference-"
          itemIds={referenceIds}
          hasMore={referenceHasMore}
          visible={!referenceLoading}
          pendingId={null}
          requestId={() => {}}
          hrefFor={referenceHref}
          messages={REFERENCE_MESSAGES}
        />
      )}
      <div className="entries-flip-wrapper">
        <main
          id="entries"
          className="entries-flip-panel mx-auto flex max-w-4xl flex-col pb-8"
          data-flip-visible={entriesFlipped ? "true" : "false"}
        >
          <div
            ref={contentWrapperRef}
            style={{
              transform: !hasMore && (eggPullY > 0 || isRebounding)
                ? `translate3d(0, -${eggPullY}px, 0)`
                : undefined,
              willChange: !hasMore && eggPullY > 0 && !isRebounding
                ? "transform"
                : undefined,
            }}
            className={!hasMore && isRebounding ? "rebound-transition" : ""}
          >
          <div className="px-4">
          {activeTopTab === 0 ? (
            <>
              {/* 标签词云：正常参与滚动 */}
              {tagCounts.length > 0 && (
                <section className="mb-5 rounded-2xl border border-zinc-200 bg-white/60 px-4 py-5 shadow-sm transition-apple dark:border-zinc-800 dark:bg-zinc-900/40 [contain:layout_paint]">
                  <div className="flex flex-wrap items-center gap-2">
                    {tagCounts.map(({ name, value }) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => handleTagClick(name)}
                        className={`rounded-full px-2.5 py-1 transition-apple focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-zinc-900 ${getSizeClass(value, maxTagCount)} ${
                          selectedTag === name
                            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                            : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 hover:scale-105 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                        }`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  {selectedTag && (
                    <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                      当前筛选：{selectedTag}（共 {totalPosts} 篇）
                      <button
                        type="button"
                        onClick={() => handleTagClick(selectedTag)}
                        className="ml-2 rounded underline transition-apple hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2"
                      >
                        取消
                      </button>
                    </p>
                  )}
                </section>
              )}

              {/* 日记列表：流式滚动 */}
              <section className="entries-page-fade-in space-y-4 pt-5 text-sm">
                {loading && (
                  <p className="px-3 text-xs text-zinc-500 dark:text-zinc-400">
                    加载中…
                  </p>
                )}
                {!loading && currentEntries.length === 0 && (
                  <p className="px-3 text-xs text-zinc-500 dark:text-zinc-400">
                    暂无文章
                  </p>
                )}
                {!loading &&
                  currentEntries.map((item) => (
                    <EntryCard
                      key={item.id}
                      item={item}
                      authorName={profile?.name ?? "DailyRhapsody"}
                      avatarSrc={profile?.avatar ?? "/avatar.png"}
                      canEdit={isAdminSession}
                      onOpenImages={(urls, i) =>
                        setLightbox({ urls, i, lbKey: `entry-${item.id}-${i}` })
                      }
                    />
                  ))}
                {hasMore && !loading && <div ref={sentinelRef} className="h-4" aria-hidden />}
                {loadingMore && (
                  <div className="flex justify-center py-6" role="status" aria-label="加载中">
                    <svg
                      className="h-6 w-6 animate-spin text-zinc-400 dark:text-zinc-500"
                      viewBox="0 0 24 24"
                      aria-hidden
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="9"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeDasharray="32 24"
                      />
                    </svg>
                  </div>
                )}
              </section>

              {/* 彩蛋 */}
              {totalPosts > 0 && !hasMore && (eggPullY > 0 || isRebounding) && (
                <div className="pt-8 pb-10 text-center" role="status" aria-live="polite">
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">
                    被你发现了 ✨
                  </span>
                </div>
              )}
              {totalPosts > 0 && !hasMore && (
                <div className="h-[140px] shrink-0" aria-hidden />
              )}
            </>
          ) : activeTopTab === 1 ? (
            <MomentsTab
              timeline={momentsTimeline}
              loading={momentsLoading}
              hasMore={momentsHasMore}
              loadingMore={momentsLoadingMore}
              sentinelRef={momentsSentinelRef}
              onOpenLightbox={(lb) => setLightbox(lb)}
            />
          ) : (
            <ReferenceFeed
              items={referenceItems}
              total={referenceTotal}
              tagCounts={referenceTagCounts}
              loading={referenceLoading}
              loadingMore={referenceLoadingMore}
              hasMore={referenceHasMore}
              sentinelRef={referenceSentinelRef}
              selectedTag={referenceTag}
              onTagClick={(tag) => setReferenceTag((prev) => (prev === tag ? null : tag))}
            />
          )}
          </div>
          </div>
        </main>
      </div>

      <MomentLightbox
        key={lightbox?.lbKey ?? "closed"}
        open={lightbox != null}
        urls={lightbox?.urls ?? []}
        index={lightbox?.i ?? 0}
        onClose={() => setLightbox(null)}
      />
      <CognitiveTreeOverlay
        open={treeOpen}
        onClose={() => setTreeOpen(false)}
        onOpenEntry={handleTreeEntry}
      />
    </div>
  );
}
