"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ReferenceCard } from "@/components/ReferenceCard";
import { ReferenceFilters } from "@/components/reference/ReferenceFilters";
import type { ReferenceListItem } from "@/hooks/useReference";
import { useReferenceLikes } from "@/hooks/useReferenceLikes";
import { useLang } from "@/components/LangProvider";
import { filterReferenceItems, type FilterLogic, type FilterRule } from "@/lib/reference-filters";
import {
  SORT_FIELDS,
  matchesQuery,
  parseSortKeys,
  serializeSortKeys,
  sortReferenceItems,
  type SortField,
  type SortKey,
} from "@/lib/reference-sort";

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
  const { t } = useLang();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = searchParams.get("focus");
  const selectedItem = useMemo(
    () => (selectedId ? items.find((it) => it.id === selectedId) ?? null : null),
    [items, selectedId],
  );
  /** 点卡片上的圆圈切换选中：再点一次清除 focus，排行榜带进来的选中也能这样撤销。 */
  const toggleSelect = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (params.get("focus") === id) {
      params.delete("focus");
    } else {
      params.set("focus", id);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [logic, setLogic] = useState<FilterLogic>("and");
  const filteredItems = useMemo(
    () => filterReferenceItems(items, rules, logic),
    [items, rules, logic],
  );
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [sorts, setSorts] = useState<SortKey[]>(() => parseSortKeys(searchParams.get("sort")));
  const visibleItems = useMemo(() => {
    const matched = filteredItems.filter((it) => matchesQuery(it, query));
    return sorts.length > 0 ? sortReferenceItems(matched, sorts) : matched;
  }, [filteredItems, query, sorts]);

  // 搜索词与排序写回 URL（300ms 防抖），刷新/分享能还原同一视图。
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      const trimmed = query.trim();
      if (trimmed) params.set("q", trimmed);
      else params.delete("q");
      const serialized = serializeSortKeys(sorts);
      if (serialized) params.set("sort", serialized);
      else params.delete("sort");
      const next = params.toString();
      if (next === searchParams.toString()) return;
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    }, 300);
    return () => clearTimeout(timer);
    // searchParams 只读取当前值，不放进依赖，避免自身写回触发循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sorts]);

  const updateSort = (index: number, field: SortField | "", dir?: "asc" | "desc") => {
    setSorts((prev) => {
      if (!field) return prev.slice(0, index);
      const next = [...prev];
      const existing = next[index];
      next[index] = { field, dir: dir ?? existing?.dir ?? "desc" };
      // 两个键不能相同：主键换成已有次键时，把次键让出去。
      return next.filter((key, i) => next.findIndex((k) => k.field === key.field) === i && i <= 1);
    });
  };
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
  }, [selectedId, visibleItems.length]);

  return (
    <>
      <h1 className="sr-only">{t("reference.title")}</h1>

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
              {t("reference.tag.current", { tag: selectedTag, total })}
              <button
                type="button"
                onClick={() => onTagClick(selectedTag)}
                className="ml-2 rounded underline transition-apple hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
              >
                {t("common.cancel")}
              </button>
            </p>
          )}
        </section>
      )}

      <ReferenceFilters
        items={items}
        rules={rules}
        logic={logic}
        resultCount={visibleItems.length}
        onRulesChange={setRules}
        onLogicChange={setLogic}
      />

      <section className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[13rem] flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden
          >
            <circle cx="11" cy="11" r="6.5" />
            <path strokeLinecap="round" d="m16 16 3.5 3.5" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("reference.search.placeholder")}
            aria-label={t("reference.search.label")}
            className="h-9 w-full rounded-full border border-zinc-200 bg-white/70 pl-9 pr-8 text-xs text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-200 dark:placeholder:text-zinc-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清空搜索"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              ×
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-zinc-400 dark:text-zinc-500">{t("reference.sort.label")}</span>
          <select
            value={sorts[0]?.field ?? ""}
            onChange={(e) => updateSort(0, e.target.value as SortField | "")}
            aria-label={t("reference.sort.primary")}
            className="h-8 cursor-pointer rounded-full border border-zinc-200 bg-white/70 px-2 text-xs text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-200"
          >
            <option value="">{t("reference.sort.default")}</option>
            {SORT_FIELDS.map((field) => (
              <option key={field.key} value={field.key}>{t(`sort.${field.key}`)}</option>
            ))}
          </select>
          {sorts[0] && (
            <button
              type="button"
              onClick={() => updateSort(0, sorts[0].field, sorts[0].dir === "asc" ? "desc" : "asc")}
              aria-label={sorts[0].dir === "asc" ? t("reference.sort.asc") : t("reference.sort.desc")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white/70 text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-300 dark:hover:text-zinc-100"
            >
              {sorts[0].dir === "asc" ? "↑" : "↓"}
            </button>
          )}
          {sorts.length === 1 && (
            <button
              type="button"
              onClick={() => {
                const fallback = SORT_FIELDS.find((f) => f.key !== sorts[0].field);
                if (fallback) updateSort(1, fallback.key, "asc");
              }}
              className="h-8 rounded-full border border-dashed border-zinc-300 px-2.5 text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-600 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              {t("reference.sort.addSecondary")}
            </button>
          )}
          {sorts[1] && (
            <>
              <select
                value={sorts[1].field}
                onChange={(e) => updateSort(1, e.target.value as SortField | "")}
                aria-label={t("reference.sort.secondary")}
                className="h-8 cursor-pointer rounded-full border border-zinc-200 bg-white/70 px-2 text-xs text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-200"
              >
                {SORT_FIELDS.filter((f) => f.key !== sorts[0]?.field).map((field) => (
                  <option key={field.key} value={field.key}>{t(`sort.${field.key}`)}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => updateSort(1, sorts[1].field, sorts[1].dir === "asc" ? "desc" : "asc")}
                aria-label={sorts[1].dir === "asc" ? t("reference.sort.asc") : t("reference.sort.desc")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white/70 text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-300 dark:hover:text-zinc-100"
              >
                {sorts[1].dir === "asc" ? "↑" : "↓"}
              </button>
            </>
          )}
        </div>
      </section>

      {selectedId && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-full border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300">
          <span className="truncate">
            {t("reference.selected.label")}
            {selectedItem
              ? selectedItem.titleZh?.trim() || selectedItem.name
              : t("reference.selected.missing")}
          </span>
          <button
            type="button"
            onClick={() => toggleSelect(selectedId)}
            className="shrink-0 rounded-full px-2 py-0.5 text-zinc-500 underline decoration-zinc-300 underline-offset-2 transition-colors hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {t("reference.selected.clear")}
          </button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <SkeletonGrid />
      ) : (
        <>
          {loading && items.length > 0 && (
            <p className="mb-2 px-1 text-[0.7rem] text-zinc-400 dark:text-zinc-500" role="status">
              {t("reference.updating")}
            </p>
          )}
          {!loading && items.length === 0 && (
            <p className="px-3 py-8 text-sm text-zinc-500 dark:text-zinc-400">
              {t("reference.empty.noItems")}
            </p>
          )}
          {!loading && items.length > 0 && visibleItems.length === 0 && (
            <p className="px-3 py-8 text-sm text-zinc-500 dark:text-zinc-400">
              {query.trim() || rules.length > 0
                ? t("reference.empty.noMatch")
                : t("reference.empty.noFilterMatch")}
            </p>
          )}
          {visibleItems.length > 0 && (
            <>
              <h2 className="sr-only">资料列表</h2>
              <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {visibleItems.map((it) => (
                  <div key={it.id} id={`reference-${it.id}`} className="scroll-mt-24">
                    <ReferenceCard
                      item={it}
                      like={likes[it.id]}
                      onLike={toggle}
                      onSelect={toggleSelect}
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
