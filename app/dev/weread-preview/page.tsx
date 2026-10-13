import { notFound } from "next/navigation";
import { CalendarHeatmap } from "@/components/entries/CalendarHeatmap";
import { ReadingStatsCard } from "@/components/entries/ReadingStatsCard";
import { fetchReadingStats } from "@/lib/weread";

/**
 * 微信读书阅读数据卡的本地预览。
 *
 * 渲染的是 /blog 上线的同一个 ReadingStatsCard，数据直接向官方网关取真实的
 * 本月与累计两个周期，不经过 Redis，因此不会污染 Cron 维护的缓存。
 *
 * 生产环境返回 404，避免误上线。卡片定稿后可连同本目录一并删除。
 */
export default async function WereadPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  const stats = await fetchReadingStats();

  // 用本月真实的发布日期喂热力图，让对照更接近线上观感
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const datesWithPosts = new Set(
    [2, 5, 6, 9, 11, 14, 15, 16, 17, 20, 21, 23, 26, 28].map(
      (d) => `${y}-${m}-${String(d).padStart(2, "0")}`,
    ),
  );

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-6 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-base font-bold">微信读书阅读数据卡 · 本地预览</h1>
        <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          与 /blog 同一个组件，数据来自官方网关的真实回包（本月与累计），不经过 Redis。
          暗色跟随系统设置。
        </p>

        <pre className="mt-4 hidden">{JSON.stringify(stats, null, 2)}</pre>

        <div
          data-hscroll
          className="entries-top-cards mt-6 flex items-start gap-4 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="shrink-0">
            <CalendarHeatmap datesWithPosts={datesWithPosts} />
          </div>

          <ReadingStatsCard stats={stats} />

          <button
            type="button"
            className="inline-flex h-[148px] w-[168px] shrink-0 flex-col items-start justify-center rounded-xl border border-zinc-200 bg-white/80 p-5 shadow-sm transition-apple opacity-60 dark:border-zinc-700 dark:bg-zinc-800/80"
          >
            <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">253</p>
            <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">篇文章</p>
            <p className="mt-1.5 text-[0.7rem] text-zinc-400 dark:text-zinc-500">本月 6 篇更新</p>
          </button>

          <button
            type="button"
            className="inline-grid h-[148px] w-[168px] shrink-0 rounded-xl border border-zinc-200 bg-white/80 p-2.5 shadow-sm transition-apple opacity-60 dark:border-zinc-700 dark:bg-zinc-800/80"
          >
            <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-[8px] bg-zinc-100 ring-1 ring-zinc-200/70 dark:bg-zinc-700/60 dark:ring-zinc-600/60"
                />
              ))}
            </div>
          </button>
        </div>

        <p className="mt-3 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          卡片条带 <code>data-hscroll</code>，触屏横滑时不再被整页切 tab 的手势接管，窄屏可滑到第四张。
        </p>

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-zinc-500 dark:text-zinc-400">
            查看网关回包汇总后的数据
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 bg-white p-3 text-[11px] leading-5 dark:border-zinc-700 dark:bg-zinc-800">
{JSON.stringify(stats, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
