"use client";

import { useState } from "react";
import { useLang } from "@/components/LangProvider";

/** 复制链接 / 系统分享。Web Share 不可用时退到剪贴板，再失败退到 prompt。 */
export function ReferenceShareButton({ title, text }: { title: string; text?: string }) {
  const { t } = useLang();
  const [done, setDone] = useState(false);

  async function share() {
    const url = window.location.href;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text: text ?? title, url });
        return;
      } catch (err) {
        // 用户主动取消不等于失败：不要转去覆盖剪贴板
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setDone(true);
      window.setTimeout(() => setDone(false), 2000);
    } catch {
      window.prompt(t("reference.detail.copyPrompt"), url);
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 transition-apple hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.7 10.7 15.3 7M8.7 13.3l6.6 3.7M6 8.8a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Zm12-4a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Zm0 10.6a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Z"
        />
      </svg>
      <span aria-live="polite">{done ? t("reference.detail.copied") : t("reference.detail.share")}</span>
    </button>
  );
}
