"use client";

import { useState } from "react";
import StickyProfileHeader from "@/components/StickyProfileHeader";
import { ReferenceCard } from "@/components/ReferenceCard";
import { useProfile, type Profile } from "@/hooks/useProfile";
import { useReference } from "@/hooks/useReference";

export default function ReferencePageClient({
  initialProfile,
}: {
  initialProfile: Profile | null;
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
  } = useReference(selectedTag);

  const handleTagClick = (tag: string) => {
    setSelectedTag((prev) => (prev === tag ? null : tag));
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-100 to-white font-sans text-zinc-900 dark:from-black dark:via-zinc-950 dark:to-black dark:text-zinc-50">
      <main
        id="reference"
        className="mx-auto flex max-w-4xl flex-col pb-8"
      >
        <StickyProfileHeader profile={profile} />

        <div className="px-4 pt-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Reference
            </h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              来自世界各处的好东西。{total > 0 ? `共 ${total} 条收藏。` : ""}
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
                    className={`rounded-full px-2.5 py-1 text-xs transition-apple focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-zinc-900 ${
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
                    className="ml-2 rounded underline transition-apple hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2"
                  >
                    取消
                  </button>
                </p>
              )}
            </section>
          )}

          <section className="space-y-3 pt-2">
            {loading && (
              <p className="px-3 text-xs text-zinc-500 dark:text-zinc-400">
                加载中…
              </p>
            )}
            {!loading && items.length === 0 && (
              <p className="px-3 text-xs text-zinc-500 dark:text-zinc-400">
                暂无收藏
              </p>
            )}
            {!loading &&
              items.map((it) => <ReferenceCard key={it.id} item={it} />)}
            {hasMore && !loading && (
              <div ref={sentinelRef} className="h-4" aria-hidden />
            )}
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
        </div>
      </main>
    </div>
  );
}
