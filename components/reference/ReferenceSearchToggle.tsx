"use client";

import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/LangProvider";

/**
 * Notion 式搜索入口：工具条上只有一个放大镜图标，点开才展开输入框。
 * 之前是常驻整行搜索条 —— 那是表单的形态，不是工具条的形态；用户对照 Notion 后要求改成图标。
 * 带 ?q= 进来（刷新、分享链接）时按 query 是否非空直接展开，否则会看不到自己在搜什么。
 */
export function ReferenceSearchToggle({
  query,
  onChange,
}: {
  query: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const expanded = open || query.length > 0;

  // 只在用户点开时抢焦点；URL 回灌的展开不抢，避免进页面就滚动到工具条。
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        // 空搜索时点外面收起；有词时保持展开，词还在列表上生效。
        if (!query) setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc 退出搜索态：清词 + 收起，回到图标。
      onChange("");
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, query, onChange]);

  return (
    <div
      ref={rootRef}
      className={expanded ? "relative w-[16rem] max-w-full" : "relative shrink-0"}
    >
      {expanded ? (
        <>
          <svg
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
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
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => onChange(event.target.value)}
            placeholder={t("reference.search.placeholder")}
            aria-label={t("reference.search.label")}
            className="h-8 w-full appearance-none rounded-lg border border-zinc-200 bg-white/70 pl-8 pr-8 text-xs text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-200 dark:placeholder:text-zinc-500 dark:focus:border-zinc-500 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
          />
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
              inputRef.current?.blur();
            }}
            aria-label={t("reference.search.clear")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            ×
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("reference.search.label")}
          title={t("reference.search.label")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white/60 text-zinc-500 transition-colors hover:bg-white hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path strokeLinecap="round" d="m16 16 3.5 3.5" />
          </svg>
        </button>
      )}
    </div>
  );
}
