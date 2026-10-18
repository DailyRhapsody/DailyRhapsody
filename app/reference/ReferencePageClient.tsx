"use client";

import Link from "next/link";
import { useState } from "react";
import StickyProfileHeader from "@/components/StickyProfileHeader";
import { ReferenceCard } from "@/components/ReferenceCard";
import { useProfile, type Profile } from "@/hooks/useProfile";
import { useReference, type ReferenceListItem } from "@/hooks/useReference";
import { useReferenceLikes } from "@/hooks/useReferenceLikes";

const TOP_CARD =
  "flex h-[148px] w-[168px] shrink-0 flex-col justify-between rounded-xl border border-zinc-200 bg-white/80 p-5 text-left shadow-sm transition-apple hover:border-zinc-300 hover:shadow-md dark:border-zinc-700 dark:bg-zinc-800/80 dark:hover:border-zinc-600";

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="资料加载中">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse overflow-hidden rounded-2xl border border-zinc-200 bg-white/60 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <div className="aspect-[4/3] bg-zinc-100 dark:bg-zinc-800" />
          <div className="space-y-2 p-4">
            <div className="h-2.5 w-20 rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-4 w-4/5 rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-2.5 w-full rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ReferencePageClient({
  initialProfile,
  initialItems,
  initialTotal,
  initialTagCounts,
}: {
  initialProfile: Profile | null;
  initialItems?: ReferenceListItem[];
  initialTotal?: number;
  initialTagCounts?: { name: string; value: number }[];
}) {
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const profile = useProfile(initialProfile);
  const {
    items,
    total,
    tagCounts,
    loading,
    loadingMore,
    hasMore,
    sentinelRef,
  } = useReference(
    selectedTag,
    initialItems
      ? {
          items: initialItems,
          total: initialTotal ?? initialItems.length,
          tagCounts: initialTagCounts ?? [],
        }
      : undefined,
  );
  const { likes, toggle } = useReferenceLikes(items.map((it) => it.id));

  const handleTagClick = (tag: string) => {
    setSelectedTag((prev) => (prev === tag ? null : tag));
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-100 to-white font-sans text-zinc-900 dark:from-black dark:via-zinc-950 dark:to-black dark:text-zinc-50">
      <main id="reference" className="mx-auto flex max-w-6xl flex-col pb-8">
        <StickyProfileHeader profile={profile} />

        {/* 站内第三个位置：和博客、动态并列。真跳转，不进 /blog 的 replaceState 状态机。 */}
        <nav
          aria-label="内容切换"
          className="flex gap-3 overflow-x-auto px-4 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-hscroll
        >
          {/* 当前页放第一：手机 375px 下三张卡放不下，第三张会被裁在视口外 */}
          <div
            aria-current="page"
            className={`${TOP_CARD} ring-2 ring-inset ring-zinc-400 dark:ring-zinc-500`}
          >
            <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">参考</p>
            <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">
              {total > 0 ? `${total} 条资料` : "行业资料库"}
            </p>
          </div>
          <Link href="/blog" className={TOP_CARD}>
            <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">博客</p>
            <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">文章与日常</p>
          </Link>
          <Link href="/moments" className={TOP_CARD}>
            <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">动态</p>
            <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">图片与片段</p>
          </Link>
        </nav>

        <div className="px-4 pt-5">
          <div className="mb-5">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Reference
            </h1>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              机器人行业的资料、评论、实测与访谈。{total > 0 ? `共 ${total} 条。` : ""}
            </p>
          </div>

          {tagCounts.length > 0 && (
            <section className="mb-5 rounded-2xl border border-zinc-200 bg-white/60 px-4 py-4 shadow-sm transition-apple dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="flex flex-wrap items-center gap-2">
                {tagCounts.map(({ name, value }) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => handleTagClick(name)}
                    className={`rounded-full px-2.5 py-1 text-xs transition-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900 ${
                      selectedTag === name
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 hover:scale-105 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                    }`}
                  >
                    {name}
                    <span className="ml-1 opacity-60">{value}</span>
                  </button>
                ))}
              </div>
              {selectedTag && (
                <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                  当前筛选：{selectedTag}（共 {total} 条）
                  <button
                    type="button"
                    onClick={() => handleTagClick(selectedTag)}
                    className="ml-2 rounded underline transition-apple hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                  >
                    取消
                  </button>
                </p>
              )}
            </section>
          )}

          {loading && items.length === 0 ? (
            <SkeletonGrid />
          ) : (
            <>
              {loading && items.length > 0 && (
                <p className="mb-2 px-1 text-[0.7rem] text-zinc-400 dark:text-zinc-500" role="status">
                  更新中…
                </p>
              )}
              {!loading && items.length === 0 && (
                <p className="px-3 py-8 text-sm text-zinc-500 dark:text-zinc-400">
                  暂无资料。等作者从 Notion 添加入库后，这里会自动出现。
                </p>
              )}
              {items.length > 0 && (
                <>
                  <h2 className="sr-only">资料列表</h2>
                  <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {items.map((it) => (
                      <ReferenceCard
                        key={it.id}
                        item={it}
                        like={likes[it.id]}
                        onLike={toggle}
                      />
                    ))}
                  </section>
                </>
              )}
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
            </>
          )}
        </div>
      </main>
    </div>
  );
}
