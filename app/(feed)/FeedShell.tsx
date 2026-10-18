"use client";

import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import FeedHeader from "./FeedHeader";
import { CalendarHeatmap } from "@/components/entries/CalendarHeatmap";
import { ReadingStatsCard } from "@/components/entries/ReadingStatsCard";
import type { StickyProfileHeaderData } from "@/components/StickyProfileHeader";
import type { ReadingStats } from "@/lib/weread";

export type FeedStats = {
  totalPosts: number;
  thisMonthPostCount: number;
  dates: string[];
  momentsThumbs: { src: string; isVideo: boolean }[];
  referenceTotal: number;
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
  const router = useRouter();
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
  const datesWithPosts = useMemo(() => new Set(stats.dates), [stats.dates]);

  const navigateTab = useCallback(
    (target: 0 | 1 | 2) => {
      if (target === active) return;
      if (target === 2) {
        router.push("/reference");
        return;
      }
      const path = target === 0 ? "/blog" : "/moments";
      if (pathname === "/reference") {
        router.push(path);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      params.delete("tab");
      const query = params.toString();
      const hash = target === 0 ? window.location.hash : "";
      window.history.replaceState(
        null,
        "",
        `${path}${query ? `?${query}` : ""}${hash}`,
      );
    },
    [active, pathname, router],
  );

  return (
    <FeedStatsContext.Provider value={contextValue}>
      <div
        className={`min-h-screen font-sans text-zinc-900 select-none dark:text-zinc-50 [&_:is(input,textarea,[contenteditable=true])]:select-text ${
          active === 2
            ? "bg-gradient-to-b from-zinc-100 to-white dark:from-black dark:via-zinc-950 dark:to-black"
            : "bg-[#f1f1f1]/80 dark:bg-black/80"
        }`}
      >
        <FeedHeader
          profile={profile}
          bgmSrc={bgmSrc}
          className="mx-auto w-full max-w-4xl"
        />
        <div className="mx-auto w-full max-w-4xl px-4 pt-5">
          <div
            data-hscroll
            className="entries-top-cards mb-5 -mx-4 flex items-start gap-3 overflow-x-auto px-2 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="shrink-0">
              <CalendarHeatmap datesWithPosts={datesWithPosts} />
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

            <button
              type="button"
              onClick={() => navigateTab(2)}
              aria-current={active === 2 ? "page" : undefined}
              className={`${CARD} ${active === 2 ? ACTIVE : INACTIVE}`}
            >
              <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">参考</p>
              <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">
                {stats.referenceTotal > 0
                  ? `${stats.referenceTotal} 条资料`
                  : "行业资料库"}
              </p>
            </button>
          </div>
        </div>
        {children}
      </div>
    </FeedStatsContext.Provider>
  );
}
