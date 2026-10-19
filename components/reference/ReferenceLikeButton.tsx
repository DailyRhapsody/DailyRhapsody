"use client";

import { useReferenceLikes } from "@/hooks/useReferenceLikes";
import { useLang } from "@/components/LangProvider";

/** 详情页点赞按钮：文案用「有用」，比「点赞」更贴行业资料场景 */
export function ReferenceLikeButton({ id }: { id: string }) {
  const { t } = useLang();
  const { likes, toggle } = useReferenceLikes([id]);
  const state = likes[id] ?? { count: 0, liked: false };

  return (
    <button
      type="button"
      onClick={() => toggle(id)}
      aria-pressed={state.liked}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${
        state.liked
          ? "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
          : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }`}
    >
      <svg
        className="h-4 w-4"
        viewBox="0 0 24 24"
        fill={state.liked ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 20.25s-7.5-4.6-7.5-10.1A4.15 4.15 0 0 1 12 7.3a4.15 4.15 0 0 1 7.5 2.85c0 5.5-7.5 10.1-7.5 10.1Z"
        />
      </svg>
      <span>{t("reference.detail.useful")}</span>
      <span className="tabular-nums opacity-70">{state.count}</span>
    </button>
  );
}
