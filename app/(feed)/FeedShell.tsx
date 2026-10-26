"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import FeedHeader from "./FeedHeader";
import { CalendarHeatmap } from "@/components/entries/CalendarHeatmap";
import { ReadingStatsCard } from "@/components/entries/ReadingStatsCard";
import type { StickyProfileHeaderData } from "@/components/StickyProfileHeader";
import type { ReadingStats } from "@/lib/weread";
import type { PostCountsByDate } from "@/lib/post-activity";

export type FeedStats = {
  totalPosts: number;
  thisMonthPostCount: number;
  /** 日期 → 当天发布篇数；热力图分档与「本月 N 篇」同源 */
  dateCounts: PostCountsByDate;
  momentsThumbs: { src: string; isVideo: boolean }[];
  referenceTotal: number;
  referenceTop: { id: string; title: string }[];
};

type FeedStatsContextValue = {
  stats: FeedStats;
  publish: (patch: Partial<FeedStats>) => void;
};

const FeedStatsContext = createContext<FeedStatsContextValue | null>(null);

/** 页面把自己的统计值发布给共享外壳；不新增任何接口请求。 */
export function usePublishFeedStats(patch: Partial<FeedStats>) {
  const ctx = useContext(FeedStatsContext);
  const serialized = JSON.stringify(patch);
  useEffect(() => {
    if (!ctx) return;
    ctx.publish(JSON.parse(serialized) as Partial<FeedStats>);
  }, [ctx, serialized]);
}

const CARD =
  "inline-flex h-[148px] w-[168px] shrink-0 flex-col items-start justify-center rounded-xl border border-zinc-200 bg-white/80 p-5 shadow-sm transition-apple dark:border-zinc-700 dark:bg-zinc-800/80";
const ACTIVE = "ring-2 ring-inset ring-zinc-400 dark:ring-zinc-500";
const INACTIVE = "opacity-60";

export default function FeedShell({
  profile,
  bgmSrc,
  readingStats,
  initialStats,
  children,
}: {
  profile: StickyProfileHeaderData | null;
  bgmSrc?: string;
  readingStats: ReadingStats | null;
  initialStats: FeedStats;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [stats, setStats] = useState<FeedStats>(initialStats);

  const publish = useCallback((patch: Partial<FeedStats>) => {
    setStats((prev) => {
      const keys = Object.keys(patch) as (keyof FeedStats)[];
      const same = keys.every(
        (key) => JSON.stringify(prev[key]) === JSON.stringify(patch[key]),
      );
      return same ? prev : { ...prev, ...patch };
    });
  }, []);

  const contextValue = useMemo(
    () => ({ stats, publish }),
    [stats, publish],
  );

  const active = pathname === "/moments" ? 1 : pathname === "/reference" ? 2 : 0;

  /* 顶部横向卡片在视口边缘直接裁切会显得生硬：根据滚动位置动态给左右边缘加渐隐。 */
  const topCardsRef = useRef<HTMLDivElement>(null);
  const [topFade, setTopFade] = useState({ left: false, right: false });
  const updateTopFade = useCallback(() => {
    const el = topCardsRef.current;
    if (!el) return;
    const next = {
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    };
    setTopFade((prev) =>
      prev.left === next.left && prev.right === next.right ? prev : next,
    );
  }, []);
  useEffect(() => {
    const el = topCardsRef.current;
    if (!el) return;
    updateTopFade();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateTopFade) : null;
    ro?.observe(el);
    window.addEventListener("resize", updateTopFade);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", updateTopFade);
    };
  }, [updateTopFade]);
  const topMask =
    topFade.left && topFade.right
      ? "linear-gradient(to right, transparent 0, black 40px, black calc(100% - 40px), transparent 100%)"
      : topFade.left
        ? "linear-gradient(to right, transparent 0, black 40px, black 100%)"
        : topFade.right
          ? "linear-gradient(to right, black 0, black calc(100% - 40px), transparent 100%)"
          : undefined;

  const navigateTab = useCallback(
    (target: 0 | 1 | 2) => {
      if (target === active) return;
      const path =
        target === 0 ? "/blog" : target === 1 ? "/moments" : "/reference";
      const params = new URLSearchParams(window.location.search);
      params.delete("tab");
      const query = params.toString();
      const hash = target === 0 ? window.location.hash : "";
      // 三个 tab 共用同一个 EntriesPageClient；只改地址与内容，不触发路由导航。
      window.history.replaceState(
        null,
        "",
        `${path}${query ? `?${query}` : ""}${hash}`,
      );
    },
    [active],
  );

  return (
    <FeedStatsContext.Provider value={contextValue}>
      <div
        className={`min-h-screen bg-[#f1f1f1]/80 font-sans text-zinc-900 select-none dark:bg-black/80 dark:text-zinc-50 [&_:is(input,textarea,[contenteditable=true])]:select-text`}
      >
        <FeedHeader
          profile={profile}
          bgmSrc={bgmSrc}
          className="mx-auto w-full max-w-4xl"
        />
        <div className="mx-auto w-full max-w-4xl px-4 pt-5">
          <div
            ref={topCardsRef}
            data-hscroll
            onScroll={updateTopFade}
            style={{ WebkitMaskImage: topMask, maskImage: topMask }}
            className="entries-top-cards mb-5 -mx-4 flex items-start gap-4 overflow-x-auto px-4 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="shrink-0">
              <CalendarHeatmap dateCounts={stats.dateCounts} />
            </div>
            <ReadingStatsCard stats={readingStats} />

            <button
              type="button"
              onClick={() => navigateTab(0)}
              aria-current={active === 0 ? "page" : undefined}
              className={`${CARD} ${active === 0 ? ACTIVE : INACTIVE}`}
            >
              <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {stats.totalPosts}
              </p>
              <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">篇文章</p>
              <p className="mt-1.5 text-[0.7rem] text-zinc-400 dark:text-zinc-500">
                本月 {stats.thisMonthPostCount} 篇更新
              </p>
            </button>

            <button
              type="button"
              onClick={() => navigateTab(1)}
              aria-current={active === 1 ? "page" : undefined}
              className={`inline-grid h-[148px] w-[168px] shrink-0 rounded-xl border border-zinc-200 bg-white/80 p-2.5 shadow-sm transition-apple dark:border-zinc-700 dark:bg-zinc-800/80 ${
                active === 1 ? ACTIVE : INACTIVE
              }`}
            >
              <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-2">
                {Array.from({ length: 4 }).map((_, i) => {
                  const item = stats.momentsThumbs[i];
                  return (
                    <div
                      key={item ? `${item.src}-${i}` : `ph-${i}`}
                      className="relative overflow-hidden rounded-[8px] bg-zinc-100 ring-1 ring-zinc-200/70 dark:bg-zinc-700/60 dark:ring-zinc-600/60"
                    >
                      {item ? (
                        item.isVideo ? (
                          <video
                            src={item.src}
                            muted
                            playsInline
                            preload="metadata"
                            className="absolute inset-0 h-full w-full object-cover"
                          />
                        ) : (
                          <Image
                            src={item.src}
                            alt=""
                            fill
                            className="object-cover"
                            sizes="76px"
                          />
                        )
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </button>

            <div
              className={`relative flex h-[148px] w-[168px] shrink-0 flex-col items-start justify-center rounded-xl border border-zinc-200 bg-white/80 p-5 shadow-sm transition-apple dark:border-zinc-700 dark:bg-zinc-800/80 ${
                active === 2 ? ACTIVE : INACTIVE
              }`}
            >
              <Link
                href="/reference"
                aria-current={active === 2 ? "page" : undefined}
                aria-label={`参考资料，共 ${stats.referenceTotal} 条`}
                className="absolute inset-0 z-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
              />
              {stats.referenceTop.length > 0 ? (
                <ol className="pointer-events-none relative z-10 flex w-full flex-col gap-1.5">
                  {stats.referenceTop.slice(0, 5).map((item, i) => (
                    <li key={item.id} className="flex min-w-0 items-baseline gap-1.5 text-left">
                      <span
                        className={`w-3 shrink-0 text-right text-[10px] font-semibold tabular-nums ${
                          i < 3
                            ? "text-rose-500 dark:text-rose-400"
                            : "text-zinc-400 dark:text-zinc-500"
                        }`}
                      >
                        {i + 1}
                      </span>
                      <Link
                        href={`/reference?focus=${encodeURIComponent(item.id)}`}
                        className="pointer-events-auto min-w-0 truncate rounded text-[0.72rem] leading-4 text-zinc-700 transition-colors hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:text-zinc-300 dark:hover:text-blue-300"
                      >
                        {item.title}
                      </Link>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="px-1 text-[12px] leading-4 text-zinc-400 dark:text-zinc-500">
                  暂无资料
                </p>
              )}
            </div>
          </div>
        </div>
        {children}
      </div>
    </FeedStatsContext.Provider>
  );
}
