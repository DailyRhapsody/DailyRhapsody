"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

/**
 * 数字人头顶的「每日一句」。
 *
 * - 服务端每天只生成一句（app/api/persona/daily-quote），这里只取一次；
 * - 叉掉后按设备记住，当天不再出现：键里存北京时间的日期，跨天自然失效；
 * - 取不到（204、断网、尚未生成）就什么都不渲染，不占位、不提示。
 */

const DISMISS_KEY = "dr_daily_quote_dismissed";

/** 与接口同一个「今天」：缓存键按北京时间，客户端日历时区不同会错一天 */
function beijingDate(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
}

export function DailyQuote({ hidden = false }: { hidden?: boolean }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let date = "";
    try {
      date = beijingDate();
      if (localStorage.getItem(DISMISS_KEY) === date) return;
    } catch {
      // 隐私模式禁用 localStorage：照常显示，只是记不住「已叉掉」
    }
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetchWithTimeout("/api/persona/daily-quote", { signal: ctrl.signal }, 45_000);
        if (res.status !== 200) return;
        const data = (await res.json()) as { text?: unknown };
        const value = typeof data.text === "string" ? data.text.trim() : "";
        if (!value) return;
        // 请求期间读者可能已经叉掉，也可能已跨天：落库前再核一次
        try {
          if (localStorage.getItem(DISMISS_KEY) === beijingDate()) return;
        } catch {
          /* 同上 */
        }
        setText(value);
      } catch {
        // AbortError 与网络失败都不渲染
      }
    })();
    return () => ctrl.abort();
  }, []);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, beijingDate());
    } catch {
      /* 记不住就只在本次渲染里收起 */
    }
    setText(null);
  }, []);

  if (!text) return null;
  return (
    <div
      data-daily-quote
      // 入口 bottom 1.25rem、高约 5.25rem；这句话落在入口上方 2.5rem 处，
      // 既不贴住数字人，也避开正文列：宽度 15rem 时，视口 ≥1440 就整块落在右侧空档里
      style={{ bottom: "calc(1.25rem + 7.75rem)" }}
      className={`fixed right-4 z-[100] w-[min(15rem,calc(100vw-2rem))] sm:right-6 ${hidden ? "hidden" : ""}`}
    >
      <div className="relative rounded-2xl bg-white/85 py-3 pl-3.5 pr-8 text-[13px] leading-relaxed text-zinc-700 shadow-sm ring-1 ring-black/5 backdrop-blur-md dark:bg-zinc-900/80 dark:text-zinc-200 dark:ring-white/10">
        <p className="m-0">{text}</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="收起今天这一句"
          className="absolute right-1 top-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-500 dark:hover:text-zinc-300"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
