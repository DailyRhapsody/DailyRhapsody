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
  const { t } = useLang();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = searchParams.get("focus");
  const focusedRef = useRef<string | null>(null);

  /** 写 URL 时读实时 location.search，避免用渲染时的旧快照覆盖掉刚写入的 focus/q。 */
  const replaceParams = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(window.location.search);
    mutate(params);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  /**
   * 点卡片本体切换选中：再点一次清除 focus。选中只改 URL，不滚动、不跳详情，
   * 详情由卡片标题与「阅读」进入。
   */
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

  /**
   * 排行榜 / 深链带进 `?focus=` 时，把目标卡滚到视口中间。
   * 不用 hash 锚点：锚点是「顶对齐 + scroll-mt」，会停在吸顶头下方偏上的位置，
   * 看起来像落到了上一张卡；也不直接用 scrollIntoView：参考卡在 3D 面板里，
   * 可视盒被投影压缩，按可视 rect 算会偏。这里用 offsetTop 链算布局坐标再校正一次，
   * 兜住图片解码、吸顶头收缩与分页加载带来的位移。
   */
  useEffect(() => {
    if (!selectedId) {
      focusedRef.current = null;
      return;
    }
    if (focusedRef.current === selectedId) return;

    let cancelled = false;
    let frames = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const layoutTop = (el: HTMLElement) => {
      let y = 0;
      let node: HTMLElement | null = el;
      while (node) {
        y += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }
      return y;
    };

    const centerOn = (el: HTMLElement) => {
      const top = layoutTop(el);
      const centered = top - Math.max(0, (window.innerHeight - el.offsetHeight) / 2);
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: Math.max(0, centered), behavior: reduceMotion ? "auto" : "smooth" });
    };

    const run = () => {
      if (cancelled) return;
      const el = document.getElementById(`reference-${selectedId}`);
      if (!el) {
        // 列表还没渲染出目标卡（首屏仍在加载）：等下一帧再找，最多约 2.5 秒。
        if (frames++ < 150) requestAnimationFrame(run);
        return;
      }
      focusedRef.current = selectedId;
      centerOn(el);
      timer = setTimeout(() => {
        if (cancelled) return;
        const rect = el.getBoundingClientRect();
        const delta = rect.top + rect.height / 2 - window.innerHeight / 2;
        if (Math.abs(delta) > 8) centerOn(el);
      }, 450);
    };

    requestAnimationFrame(run);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedId, visibleItems.length]);

  /**
   * 选中只用于排行榜定位（`?focus=`），不作常驻高亮：点卡片以外的空白处即撤销。
   * 卡片、链接与表单控件上的点击不参与，否则开详情、换筛选时会被顺手清掉。
   * 用捕获阶段：卡片与覆盖层里有人 stopPropagation 时，冒泡阶段的监听会被吞掉。
   */
  useEffect(() => {
    if (!selectedId) return;
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest("a,button,input,select,textarea,[role='button'],[data-ref-card]")) return;
      replaceParams((params) => params.delete("focus"));
    };
    document.addEventListener("click", onDocumentClick, true);
    return () => document.removeEventListener("click", onDocumentClick, true);
    // replaceParams 每次渲染都是新函数，放进依赖会让监听器反复重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

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
                  <div key={it.id} id={`reference-${it.id}`} data-ref-card className="scroll-mt-24">
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
