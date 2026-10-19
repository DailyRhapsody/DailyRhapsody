"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReferenceCard } from "@/components/ReferenceCard";
import { ReferenceFilters } from "@/components/reference/ReferenceFilters";
import type { ReferenceListItem } from "@/hooks/useReference";
import { useReferenceLikes } from "@/hooks/useReferenceLikes";
import { filterReferenceItems, type FilterLogic, type FilterRule } from "@/lib/reference-filters";

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="资料加载中">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-zinc-200 bg-white/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <div className="space-y-2">
            <div className="h-2.5 w-20 rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-4 w-4/5 rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-2.5 w-full rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-2.5 w-3/5 rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 参考页的内容区：标签、筛选、卡片列表与分页。
 * 数据由 EntriesPageClient 统一持有，和顶部卡、时间轴共用同一份列表。
 */
export default function ReferenceFeed({
  items,
  total,
  tagCounts,
  loading,
  loadingMore,
  hasMore,
  sentinelRef,
  selectedTag,
  onTagClick,
}: {
  items: ReferenceListItem[];
  total: number;
  tagCounts: { name: string; value: number }[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  selectedTag: string | null;
  onTagClick: (tag: string) => void;
}) {
  const { likes, toggle } = useReferenceLikes(items.map((it) => it.id));
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("focus");
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [logic, setLogic] = useState<FilterLogic>("and");
  const filteredItems = useMemo(
    () => filterReferenceItems(items, rules, logic),
    [items, rules, logic],
  );
  const focusedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedId) {
      focusedRef.current = null;
      return;
    }
    const el = document.getElementById(`reference-${selectedId}`);
    if (!el) return;
    focusedRef.current = selectedId;
    const frame = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, filteredItems.length]);

  return (
    <>
      <h1 className="sr-only">Reference · 机器人行业资料库</h1>

      {tagCounts.length > 0 && (
        <section className="mb-5 rounded-xl border border-zinc-200 bg-white/60 px-4 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="flex flex-wrap items-center gap-2">
            {tagCounts.map(({ name, value }) => (
              <button
                key={name}
                type="button"
                onClick={() => onTagClick(name)}
                className={`rounded-full px-2.5 py-1 text-xs transition-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900 ${
                  selectedTag === name
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                }`}
              >
                {name}
                <span className="ml-1 opacity-60">{value}</span>
              </button>
            ))}
          </div>
          {selectedTag && (
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              当前标签：{selectedTag}（共 {total} 条）
              <button
                type="button"
                onClick={() => onTagClick(selectedTag)}
                className="ml-2 rounded underline transition-apple hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
              >
                取消
              </button>
            </p>
          )}
        </section>
      )}

      <ReferenceFilters
        items={items}
        rules={rules}
        logic={logic}
        resultCount={filteredItems.length}
        onRulesChange={setRules}
        onLogicChange={setLogic}
      />

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
          {!loading && items.length > 0 && filteredItems.length === 0 && (
            <p className="px-3 py-8 text-sm text-zinc-500 dark:text-zinc-400">
              没有符合当前条件的资料。
            </p>
          )}
          {filteredItems.length > 0 && (
            <>
              <h2 className="sr-only">资料列表</h2>
              <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {filteredItems.map((it) => (
                  <div key={it.id} id={`reference-${it.id}`} className="scroll-mt-24">
                    <ReferenceCard
                      item={it}
                      like={likes[it.id]}
                      onLike={toggle}
                      selected={selectedId === it.id}
                    />
                  </div>
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
    </>
  );
}
