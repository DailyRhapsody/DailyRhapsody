"use client";

import { useState } from "react";
import { VisitorWorldMap } from "@/components/entries/VisitorWorldMap";
import type { VisitorMapPoint } from "@/lib/visitor-map";

/**
 * 访客地图 · 本地预览（/dev/worldmap-preview，生产 404）。
 *
 * 渲染的是 /blog 上线的同一个 VisitorWorldMap 组件与同一套卡片样式，唯一多出来的是顶部的强度滑块：
 * 底图强弱很主观，先在这里定档，再把默认值写回组件。
 * 光点是示意分布，不是真实访客数据。
 */
const DEMO_POINTS: VisitorMapPoint[] = [
  { lat: 40.09, lon: 115.85, count: 38 },
  { lat: 30.75, lon: 121.6, count: 34 },
  { lat: 22.98, lon: 113.89, count: 26 },
  { lat: 23.5, lon: 112.9, count: 21 },
  { lat: 30.28, lon: 119.6, count: 19 },
  { lat: 30.75, lon: 103.4, count: 14 },
  { lat: 32.09, lon: 118.1, count: 11 },
  { lat: 30.75, lon: 113.89, count: 9 },
  { lat: 34.56, lon: 108.3, count: 8 },
  { lat: 22.51, lon: 113.89, count: 15 },
  { lat: 24.55, lon: 121.6, count: 13 },
  { lat: 35.62, lon: 139.09, count: 16 },
  { lat: 37.31, lon: 127.22, count: 9 },
  { lat: 1.91, lon: 103.4, count: 12 },
  { lat: 13.26, lon: 100.05, count: 6 },
  { lat: 19.23, lon: 72.82, count: 7 },
  { lat: 25.1, lon: 55.05, count: 5 },
  { lat: 51.29, lon: 0.34, count: 10 },
  { lat: 52.8, lon: 13.64, count: 6 },
  { lat: 48.86, lon: 2.24, count: 6 },
  { lat: 52.31, lon: 4.72, count: 4 },
  { lat: 59.61, lon: 18.32, count: 3 },
  { lat: 55.85, lon: 37.65, count: 4 },
  { lat: 38.03, lon: -122.2, count: 13 },
  { lat: 47.54, lon: -122.29, count: 8 },
  { lat: 40.49, lon: -73.89, count: 11 },
  { lat: 43.48, lon: -79.2, count: 6 },
  { lat: -23.24, lon: -46.7, count: 4 },
  { lat: 19.15, lon: -99.06, count: 3 },
  { lat: -33.73, lon: 150.9, count: 8 },
  { lat: -36.67, lon: 174.53, count: 3 },
  { lat: -33.97, lon: 18.19, count: 2 },
  { lat: -1.12, lon: 36.88, count: 2 },
];

const SUMMARY =
  "这里是文章摘要的示例文本，用来看正文在透光底图上的可读性。行数按真实文章的长度给，方便判断卡片透明度是否合适。";

export default function WorldMapPreviewClient() {
  const [intensity, setIntensity] = useState(1);
  const [pointsOn, setPointsOn] = useState(true);

  return (
    <div className="min-h-screen select-none bg-gradient-to-b from-zinc-100/75 to-white/55 font-sans text-zinc-900 dark:from-black/85 dark:via-zinc-950/55 dark:to-black/90 dark:text-zinc-50">
      <VisitorWorldMap points={pointsOn ? DEMO_POINTS : null} intensity={intensity} />

      <div className="fixed left-4 top-4 z-50 w-[min(92vw,26rem)] rounded-xl border border-zinc-300 bg-white/95 p-3 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900/95">
        <p className="font-semibold">访客地图底图 · 本地预览</p>
        <p className="mt-1 leading-5 text-zinc-500 dark:text-zinc-400">
          数据是示意分布，不是真实访客；<span className="font-medium text-zinc-700 dark:text-zinc-200">强度默认值请在这里定档后告诉我</span>。
        </p>
        <label className="mt-2 flex items-center gap-2">
          底图强度 {intensity.toFixed(2)}
          <input
            type="range"
            min={0.2}
            max={2.4}
            step={0.05}
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
            className="flex-1"
          />
        </label>
        <label className="mt-1 flex items-center gap-2">
          <input type="checkbox" checked={pointsOn} onChange={(e) => setPointsOn(e.target.checked)} />
          显示访客光点
        </label>
        <p className="mt-1 leading-5 text-zinc-500 dark:text-zinc-400">
          深浅色跟随系统外观。生产环境这个页面返回 404。
        </p>
      </div>

      <main className="relative mx-auto flex max-w-4xl flex-col pb-8 pt-16">
        <div className="px-4 pt-5">
          <div className="mb-5 -mx-4 flex items-start gap-4 overflow-x-auto px-4 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="inline-flex h-[148px] w-[168px] shrink-0 flex-col items-start justify-center rounded-xl border border-zinc-200 bg-white/80 p-5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/80">
              <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">253</p>
              <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">篇文章</p>
              <p className="mt-1.5 text-[0.7rem] text-zinc-400 dark:text-zinc-500">本月 6 篇更新</p>
            </div>
            <div className="inline-grid h-[148px] w-[168px] shrink-0 grid-cols-4 grid-rows-4 gap-1 rounded-xl border border-zinc-200 bg-white/80 p-2.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/80">
              {Array.from({ length: 16 }).map((_, i) => (
                <span
                  key={i}
                  className="rounded-[2px] bg-emerald-300/70"
                  style={{ opacity: 0.25 + ((i * 7) % 11) / 14 }}
                />
              ))}
            </div>
            <div className="inline-flex h-[148px] w-[168px] shrink-0 flex-col items-start justify-center rounded-xl border border-zinc-200 bg-white/80 p-5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/80">
              <p className="text-xl font-bold text-zinc-900 dark:text-zinc-50">—</p>
              <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">小时阅读时长</p>
              <div className="mt-2 flex h-10 w-full items-end gap-1">
                {Array.from({ length: 12 }).map((_, i) => (
                  <span
                    key={i}
                    className="flex-1 rounded-[2px] bg-zinc-300 dark:bg-zinc-600"
                    style={{ height: `${20 + ((i * 37) % 70)}%` }}
                  />
                ))}
              </div>
            </div>
            <div className="inline-grid h-[148px] w-[168px] shrink-0 grid-cols-2 grid-rows-2 gap-2 rounded-xl border border-zinc-200 bg-white/80 p-2.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/80">
              {Array.from({ length: 4 }).map((_, i) => (
                <span key={i} className="rounded-[8px] bg-zinc-100 ring-1 ring-zinc-200/70 dark:bg-zinc-700/60 dark:ring-zinc-600/60" />
              ))}
            </div>
          </div>

          <section className="mb-5 rounded-2xl border border-zinc-200 bg-white/60 px-4 py-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex flex-wrap items-center gap-2">
              {["随笔", "读书", "产品", "算法", "旅行", "梦日记", "记忆", "效率", "系统", "摄影"].map((t, i) => (
                <span
                  key={t}
                  className={`rounded-full px-2.5 py-1 text-xs ${
                    i === 1
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  }`}
                >
                  {t}
                </span>
              ))}
            </div>
          </section>

          <section className="space-y-4 pt-5 text-sm">
            {[0, 1].map((i) => (
              <article
                key={i}
                className="group relative flex flex-col gap-3 rounded-2xl px-3 py-4 hover:bg-zinc-100/70 hover:shadow-md dark:hover:bg-zinc-900/80"
              >
                <div className="flex items-start gap-3">
                  <span className="h-10 w-10 shrink-0 rounded-full bg-gradient-to-br from-zinc-300 to-zinc-400 dark:from-zinc-600 dark:to-zinc-700" />
                  <div className="flex min-w-0 flex-1 flex-col justify-center">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">DailyRhapsody</p>
                    <p className="text-[0.75rem] text-zinc-500 dark:text-zinc-400">10 月 {16 - i} 日 21:4{i}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: 3 }).map((_, k) => (
                    <span
                      key={k}
                      className="h-20 w-20 rounded-lg bg-gradient-to-br from-zinc-200 to-zinc-300 dark:from-zinc-700 dark:to-zinc-800"
                    />
                  ))}
                </div>
                <p className="text-sm leading-7">{SUMMARY}</p>
                <div className="flex items-center gap-1">
                  <span className="rounded bg-zinc-200/80 px-1.5 py-0.5 text-[0.65rem] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">
                    随笔
                  </span>
                  <span className="rounded bg-zinc-200/80 px-1.5 py-0.5 text-[0.65rem] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">
                    系统
                  </span>
                  <span className="ml-auto text-[0.72rem] text-zinc-500 dark:text-zinc-400">📍 上海</span>
                </div>
              </article>
            ))}
          </section>
        </div>
      </main>
    </div>
  );
}
