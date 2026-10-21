"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ReferenceCard } from "@/components/ReferenceCard";
import { ReferenceFilters } from "@/components/reference/ReferenceFilters";
import { ReferenceSearchToggle } from "@/components/reference/ReferenceSearchToggle";
import { ReferenceSortMenu } from "@/components/reference/ReferenceSortMenu";
import type { ReferenceListItem } from "@/hooks/useReference";
import { useReferenceLikes } from "@/hooks/useReferenceLikes";
import { useLang } from "@/components/LangProvider";
import { filterReferenceItems, type FilterLogic, type FilterRule } from "@/lib/reference-filters";
import {
  matchesQuery,
  parseSortKeys,
  serializeSortKeys,
  sortReferenceItems,
  type SortField,
  type SortKey,
} from "@/lib/reference-sort";

function SkeletonGrid() {
  const { t } = useLang();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label={t("reference.list.loading")}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="ap-ref-card animate-pulse"
        >
          <div className="space-y-2">
            <div className="ap-skeleton h-2.5 w-20" />
            <div className="ap-skeleton h-4 w-4/5" />
            <div className="ap-skeleton h-2.5 w-full" />
            <div className="ap-skeleton h-2.5 w-3/5" />
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
  const { t, lang } = useLang();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = searchParams.get("focus");
  const selectedItem = useMemo(
    () => (selectedId ? items.find((it) => it.id === selectedId) ?? null : null),
    [items, selectedId],
  );
  const focusedRef = useRef<string | null>(null);

  /** 写 URL 时读实时 location.search，避免用渲染时的旧快照覆盖掉刚写入的 focus/q。 */
  const replaceParams = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(window.location.search);
    mutate(params);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  /** 点卡片上的圆圈切换选中：再点一次清除 focus，排行榜带进来的选中也能这样撤销。 */
  const toggleSelect = (id: string) => {
    const willSelect = selectedId !== id;
    // 点击选中不滚动：先把 ref 对齐，scroll effect 认为「已经处理过」。
    focusedRef.current = willSelect ? id : null;
    replaceParams((params) => {
      if (willSelect) params.set("focus", id);
      else params.delete("focus");
    });
  };
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [logic, setLogic] = useState<FilterLogic>("and");
  const filteredItems = useMemo(
    () => filterReferenceItems(items, rules, logic),
    [items, rules, logic],
  );
  const qParam = searchParams.get("q") ?? "";
  const sortParam = searchParams.get("sort") ?? "";
  const [query, setQuery] = useState(qParam);
  const [sorts, setSorts] = useState<SortKey[]>(() => parseSortKeys(sortParam));
  const visibleItems = useMemo(() => {
    const matched = filteredItems.filter((it) => matchesQuery(it, query));
    return sorts.length > 0 ? sortReferenceItems(matched, sorts) : matched;
  }, [filteredItems, query, sorts]);

  // URL 是唯一真源：排行榜/统计卡的软导航会改 URL 而不重挂组件，这里把搜索与排序回灌。
  useEffect(() => {
    setQuery(qParam);
    setSorts(parseSortKeys(sortParam));
  }, [qParam, sortParam]);

  // 搜索词与排序写回 URL（300ms 防抖），刷新/分享能还原同一视图。
  useEffect(() => {
    const timer = setTimeout(() => {
      replaceParams((params) => {
        const trimmed = query.trim();
        if (trimmed) params.set("q", trimmed);
        else params.delete("q");
        const serialized = serializeSortKeys(sorts);
        if (serialized) params.set("sort", serialized);
        else params.delete("sort");
      });
    }, 300);
    return () => clearTimeout(timer);
    // replaceParams 每次渲染都是新函数，放进依赖会让定时器反复重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sorts]);

  const updateSort = (index: number, field: SortField | "", dir?: "asc" | "desc") => {
    setSorts((prev) => {
      if (!field) return index === 0 ? [] : prev.slice(0, 1);
      const entry: SortKey = { field, dir: dir ?? prev[index]?.dir ?? "desc" };
      const others = prev.filter((_, i) => i !== index);
      const merged = index === 0 ? [entry, ...others] : [others[0], entry].filter(Boolean);
      // 两个键不能相同：主键换成原次键时相当于互换，原主键退到次级。
      return merged
        .filter((key, i, arr) => arr.findIndex((k) => k.field === key.field) === i)
        .slice(0, 2) as SortKey[];
    });
  };

  useEffect(() => {
    if (!selectedId) {
      focusedRef.current = null;
      return;
    }
    // 已经处理过这个选中项：搜索/筛选/分页导致列表长度变化时不要再把人拉回去。
    if (focusedRef.current === selectedId) return;
    const el = document.getElementById(`reference-${selectedId}`);
    if (!el) return;
    focusedRef.current = selectedId;
    const rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return; // 已经完整可见
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const frame = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
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

      {/* 工具条只有一行：左边筛选（含 chip），右边排序 + 搜索，与 Notion 一致。
          搜索 / 排序不要再单独占一行 —— 用户已就此纠正过，视为布局回退。 */}
      <ReferenceFilters
        items={items}
        rules={rules}
        logic={logic}
        resultCount={visibleItems.length}
        onRulesChange={setRules}
        onLogicChange={setLogic}
        trailing={
          <>
            {/* 图标按钮：排序点开才是面板，搜索点开才是输入框 —— Notion 工具条的样子。 */}
            <ReferenceSortMenu sorts={sorts} onChange={updateSort} />
            <ReferenceSearchToggle query={query} onChange={setQuery} />
          </>
        }
      />

      {selectedId && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-full border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300">
          <span className="truncate">
            {t("reference.selected.label")}
            {selectedItem
              ? (lang === "zh"
                  ? selectedItem.titleZh?.trim() || selectedItem.name
                  : selectedItem.name || selectedItem.titleZh?.trim())
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
              <h2 className="sr-only">{t("reference.list.heading")}</h2>
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
            <div className="flex justify-center py-6" role="status" aria-label={t("reference.loadingMore")}>
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
