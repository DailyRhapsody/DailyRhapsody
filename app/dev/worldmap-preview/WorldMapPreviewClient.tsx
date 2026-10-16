"use client";

import { useEffect, useState } from "react";
import { VisitorWorldMap } from "@/components/entries/VisitorWorldMap";
import { EntryCard } from "@/components/entries/EntryCard";
import { CalendarHeatmap } from "@/components/entries/CalendarHeatmap";
import { getSizeClass } from "@/components/entries/utils";
import type { Diary } from "@/components/entries/types";
import type { VisitorMapPoint } from "@/lib/visitor-map";

/**
 * 访客地图 · 本地预览（/dev/worldmap-preview，生产 404）。
 *
 * 文章走 /dev/api/entries —— 本机既有的脱敏只读快照 data/diaries.json（159 篇，截至 2026-03），
 * 渲染用的是 /blog 上线的同一套组件（EntryCard / CalendarHeatmap）与同一份样式类，
 * 所以排版、字号、透光与卡片层级都是真实观感，只有数据源换成本地快照。
 *
 * 访客光点仍是示意分布：本机那份访问记录快照里没有经纬度字段（250 条全为空），拿不到真实地理分布；
 * 真实分布要到 Vercel 预览（同一份 Redis）或生产上看。强度滑块只存在于这个预览页，不进产品。
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

type EntriesPayload = {
  items: Diary[];
  total: number;
  tagCounts: { name: string; value: number }[];
  dates: string[];
  source?: string;
};

export default function WorldMapPreviewClient() {
  const [intensity, setIntensity] = useState(1);
  const [pointsOn, setPointsOn] = useState(true);
  const [data, setData] = useState<EntriesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(6);
  // 页面纱层：整页均匀的一层底色。0.72 + #f0f0f1 对应产品里的 bg-[#f0f0f1]/72（深色 #020203/0.78）
  const [veil, setVeil] = useState(0.72);
  const darkVeil = Math.min(1, veil + 0.06);

  useEffect(() => {
    fetch("/dev/api/entries", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`快照接口 ${r.status}`))))
      .then((d: EntriesPayload) => setData(d))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const items = data?.items ?? [];
  const tagCounts = data?.tagCounts ?? [];
  const maxTagCount = tagCounts.reduce((m, t) => Math.max(m, t.value), 1);
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = items.filter((d) => (d.publishedAt ?? d.date).slice(0, 7) === month).length;

  return (
    <div
      id="dev-root"
      className="min-h-screen select-none bg-[#f0f0f1]/72 font-sans text-zinc-900 dark:bg-[#020203]/78 dark:text-zinc-50"
    >
      {/* 预览专用：纱层滑块只覆盖这一层底色，产品类不动 */}
      <style>{`#dev-root{background-color:rgba(240,240,241,${veil})}@media (prefers-color-scheme: dark){#dev-root{background-color:rgba(2,2,3,${darkVeil.toFixed(3)})}}`}</style>
      <VisitorWorldMap points={pointsOn ? DEMO_POINTS : null} intensity={intensity} />

      <div className="fixed left-4 top-4 z-50 w-[min(92vw,26rem)] rounded-xl border border-zinc-300 bg-white/95 p-3 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900/95">
        <p className="font-semibold">访客地图底图 · 本地预览</p>
        <p className="mt-1 leading-5 text-zinc-500 dark:text-zinc-400">
          文章是<span className="font-medium text-zinc-700 dark:text-zinc-200">真实数据</span>
          （{data ? `${data.total} 篇，本机快照` : "加载中…"}，走线上同一套卡片组件）；
          光点是<span className="font-medium text-zinc-700 dark:text-zinc-200">示意分布</span>
          ，本机访问记录快照里没有经纬度。
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
        <label className="mt-1 flex items-center gap-2">
          页面纱层 {veil.toFixed(2)}
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={veil}
            onChange={(e) => setVeil(Number(e.target.value))}
            className="flex-1"
          />
        </label>
        <p className="mt-1 leading-5 text-zinc-500 dark:text-zinc-400">
          深浅色跟随系统外观；文章图片不显示（本地没有媒体代理凭证）。生产环境本页返回 404。
        </p>
      </div>

      <main className="relative mx-auto flex max-w-4xl flex-col pb-8 pt-16">
        <div className="px-4 pt-5">
          <div className="mb-5 -mx-4 flex items-start gap-4 overflow-x-auto px-4 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="shrink-0">
              <CalendarHeatmap datesWithPosts={new Set(data?.dates ?? [])} />
            </div>
            <div className="inline-flex h-[148px] w-[168px] shrink-0 flex-col items-start justify-center rounded-xl border border-zinc-200 bg-white/80 p-5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/80">
              <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{data ? data.total : "—"}</p>
              <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">篇文章</p>
              <p className="mt-1.5 text-[0.7rem] text-zinc-400 dark:text-zinc-500">本月 {thisMonth} 篇更新</p>
            </div>
            <div className="inline-flex h-[148px] w-[168px] shrink-0 flex-col items-start justify-center rounded-xl border border-zinc-200 bg-white/80 p-5 opacity-60 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/80">
              <p className="text-xl font-bold text-zinc-900 dark:text-zinc-50">—</p>
              <p className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">微信读书卡（本地无凭证）</p>
            </div>
            <div className="inline-grid h-[148px] w-[168px] shrink-0 grid-cols-2 grid-rows-2 gap-2 rounded-xl border border-zinc-200 bg-white/80 p-2.5 opacity-60 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/80">
              {Array.from({ length: 4 }).map((_, i) => (
                <span
                  key={i}
                  className="rounded-[8px] bg-zinc-100 ring-1 ring-zinc-200/70 dark:bg-zinc-700/60 dark:ring-zinc-600/60"
                />
              ))}
            </div>
          </div>

          {tagCounts.length > 0 && (
            <section className="mb-5 rounded-2xl border border-zinc-200 bg-white/60 px-4 py-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="flex flex-wrap items-center gap-2">
                {tagCounts.slice(0, 18).map(({ name, value }) => (
                  <span
                    key={name}
                    className={`rounded-full bg-zinc-100 px-2.5 py-1 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 ${getSizeClass(value, maxTagCount)}`}
                  >
                    {name}
                  </span>
                ))}
              </div>
            </section>
          )}

          {error && (
            <p className="px-3 py-4 text-xs text-amber-700 dark:text-amber-400">
              快照接口不可用：{error}
            </p>
          )}

          <section className="space-y-4 pt-5 text-sm">
            {items.slice(0, visible).map((item) => (
              <EntryCard
                key={item.id}
                item={item}
                authorName="DailyRhapsody"
                avatarSrc="/avatar.png"
                canEdit={false}
                onOpenImages={() => {}}
              />
            ))}
          </section>

          {data && visible < items.length && (
            <div className="flex justify-center py-6">
              <button
                type="button"
                onClick={() => setVisible((v) => v + 6)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                再看 6 篇（共 {items.length} 篇）
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
