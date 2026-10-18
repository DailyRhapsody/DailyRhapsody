"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ReferenceCard } from "@/components/ReferenceCard";
import { useHorizontalSwipeNavigation } from "@/hooks/useHorizontalSwipeNavigation";
import { useReference, type ReferenceListItem } from "@/hooks/useReference";
import { useReferenceLikes } from "@/hooks/useReferenceLikes";
import { usePublishFeedStats } from "../FeedShell";

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
  initialItems,
  initialTotal,
  initialTagCounts,
}: {
  initialItems?: ReferenceListItem[];
  initialTotal?: number;
  initialTagCounts?: { name: string; value: number }[];
}) {
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
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
  usePublishFeedStats({ referenceTotal: total });
  const router = useRouter();

  // 与博客、动态的顶部卡片保持同一套手势：左滑下一张（博客），右滑上一张（动态，循环）。
  const goNext = useCallback(() => router.push("/blog"), [router]);
  const goPrev = useCallback(() => router.push("/moments"), [router]);
  useHorizontalSwipeNavigation({ onNext: goNext, onPrev: goPrev });

  const handleTagClick = (tag: string) => {
    setSelectedTag((prev) => (prev === tag ? null : tag));
  };

  return (
    <div className="font-sans text-zinc-900 dark:text-zinc-50">
      <main id="reference" className="mx-auto flex max-w-4xl flex-col pb-8">
        <div className="px-4 pt-5">
          <h1 className="sr-only">Reference · 机器人行业资料库</h1>

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
