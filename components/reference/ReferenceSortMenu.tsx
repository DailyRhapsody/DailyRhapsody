"use client";

import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/LangProvider";
import { SORT_FIELDS, type SortField, type SortKey } from "@/lib/reference-sort";

/**
 * Notion 式排序入口：工具条上只占一个图标按钮，点开才出现排序面板。
 * 之前是三件控件平铺（「排序」文字 + 原生 select + ↑↓），对照 Notion 后被要求收成图标 + 面板；
 * 面板里每条排序 = 字段 + 方向 + 删除，底部是「添加排序 / 删除排序」。
 */

type DirKind = "date" | "number" | "text";

/** 方向文案按字段类型说人话：日期「新→旧」、年份「高→低」、文本「A→Z」。 */
function dirKind(field: SortField): DirKind {
  if (field === "clippedAt") return "date";
  if (field === "year") return "number";
  return "text";
}

function FieldIcon({ field }: { field: SortField }) {
  const common = "h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500";
  if (field === "clippedAt") {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
        <path strokeLinecap="round" d="M8 3v4M16 3v4M3.5 10h17" />
      </svg>
    );
  }
  if (field === "year") {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
        <path strokeLinecap="round" d="M9 5 7 19M17 5l-2 14M4.5 9.5h15M3.5 14.5h15" />
      </svg>
    );
  }
  return (
    <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <path strokeLinecap="round" d="M4 19 9.5 5 15 19M6.2 14.5h6.6M17.5 19V9.5l-2.5 2" />
    </svg>
  );
}

export function ReferenceSortMenu({
  sorts,
  onChange,
}: {
  sorts: SortKey[];
  /** 与列表同源：index 0 是主排序，切空字段即删除该条。 */
  onChange: (index: number, field: SortField | "", dir?: "asc" | "desc") => void;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const addRule = () => {
    const next = SORT_FIELDS.find((f) => !sorts.some((s) => s.field === f.key));
    if (!next) return;
    // 还没有主排序时先落一条主排序，否则面板里会出现「只有次级」的怪状态。
    onChange(sorts.length === 0 ? 0 : 1, next.key, "desc");
  };

  return (
    <div ref={rootRef} className="relative z-30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("reference.sort.label")}
        title={t("reference.sort.label")}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${
          sorts.length > 0 || open
            ? "border-zinc-300 bg-zinc-100 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            : "border-zinc-200 bg-white/60 text-zinc-500 hover:bg-white hover:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
        }`}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 20V5m0 0L4 8m3-3 3 3" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 4v15m0 0 3-3m-3 3-3-3" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("reference.sort.label")}
          className="absolute right-0 top-9 w-[21rem] rounded-xl border border-zinc-200 bg-white p-1.5 text-xs shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        >
          {sorts.length === 0 ? (
            <p className="px-2 py-2 text-zinc-400 dark:text-zinc-500">{t("reference.sort.empty")}</p>
          ) : (
            sorts.map((rule, index) => (
              <div
                key={rule.field}
                className="flex items-center gap-1 rounded-lg px-1 py-1 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
              >
                <span className="ml-0.5 inline-flex items-center">
                  <FieldIcon field={rule.field} />
                </span>
                <select
                  value={rule.field}
                  onChange={(event) => onChange(index, event.target.value as SortField)}
                  aria-label={index === 0 ? t("reference.sort.primary") : t("reference.sort.secondary")}
                  className="h-7 min-w-0 max-w-[7rem] cursor-pointer truncate rounded-md border-0 bg-transparent px-1 text-xs text-zinc-800 outline-none focus:ring-1 focus:ring-zinc-300 dark:text-zinc-100 dark:focus:ring-zinc-600"
                >
                  {SORT_FIELDS.map((field) => (
                    <option key={field.key} value={field.key}>
                      {t(`sort.${field.key}`)}
                    </option>
                  ))}
                </select>
                <select
                  value={rule.dir}
                  onChange={(event) => onChange(index, rule.field, event.target.value as "asc" | "desc")}
                  aria-label={t("reference.sort.direction")}
                  className="h-7 min-w-0 flex-1 cursor-pointer truncate rounded-md border-0 bg-transparent px-1 text-xs text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-300 dark:text-zinc-300 dark:focus:ring-zinc-600"
                >
                  <option value="desc">{t(`reference.sort.dir.${dirKind(rule.field)}.desc`)}</option>
                  <option value="asc">{t(`reference.sort.dir.${dirKind(rule.field)}.asc`)}</option>
                </select>
                <button
                  type="button"
                  onClick={() => onChange(index, "")}
                  aria-label={t("reference.sort.removeRule")}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm leading-none text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  ×
                </button>
              </div>
            ))
          )}

          <div className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-700">
            <button
              type="button"
              onClick={addRule}
              disabled={sorts.length >= 2}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
            >
              <span className="text-sm leading-none text-zinc-400" aria-hidden>+</span>
              {t("reference.sort.add")}
            </button>
            {sorts.length > 0 && (
              <button
                type="button"
                onClick={() => onChange(0, "")}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
              >
                <svg className="h-3.5 w-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
                  <path strokeLinecap="round" d="M4 7h16M9 7V5h6v2M6.5 7l.8 12.2h9.4L17.5 7M10 11v5M14 11v5" />
                </svg>
                {t("reference.sort.remove")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
