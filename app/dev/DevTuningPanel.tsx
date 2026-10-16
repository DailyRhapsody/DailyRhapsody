"use client";

import { useEffect, useState } from "react";

/**
 * 本地调档面板（只在开发环境渲染）。
 *
 * 挂在 /blog 上，让你对着真实页面点按钮定档：底图强度（VisitorWorldMap 的 intensity）、
 * 页面纱层（整页那层均匀底色的 alpha）。数值实时生效，点「复制数值」把结果贴给我即可。
 *
 * 生产构建里 process.env.NODE_ENV !== "production" 是编译期常量 false，
 * 整段（含 import）会被 tree-shake 掉，不会进产物。
 */
const INTENSITY_STEPS = [0.6, 0.8, 1.0, 1.2, 1.5];
const VEIL_STEPS = [0.45, 0.55, 0.62, 0.72, 0.82];
/** 深色比浅色多这一档，与产品里 0.62 / 0.68 的比例一致 */
const VEIL_DARK_OFFSET = 0.06;

export function DevTuningPanel({
  intensity,
  onIntensity,
}: {
  intensity: number;
  onIntensity: (v: number) => void;
}) {
  const [veil, setVeil] = useState(0.62);
  const [copied, setCopied] = useState(false);

  // 纱层直接改根元素底色（两个主题各一份），不走 React state，免得往页面组件里加逻辑
  useEffect(() => {
    const id = "dev-veil-style";
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent =
      `#blog-root{background-color:rgba(244,244,245,${veil})}` +
      `@media (prefers-color-scheme: dark){#blog-root{background-color:rgba(9,9,11,${Math.min(1, veil + VEIL_DARK_OFFSET).toFixed(2)})}}`;
  }, [veil]);

  const summary = `底图强度 ${intensity.toFixed(2)}｜页面纱层 ${veil.toFixed(2)}（深色 ${Math.min(1, veil + VEIL_DARK_OFFSET).toFixed(2)}）`;

  return (
    <div className="fixed bottom-4 left-4 z-[60] w-[min(92vw,20rem)] rounded-xl border border-amber-300/70 bg-amber-50/95 p-3 text-[0.7rem] leading-5 text-amber-900 shadow-lg dark:border-amber-500/40 dark:bg-amber-950/90 dark:text-amber-100">
      <p className="font-semibold">调档面板（仅本地可见）</p>

      <div className="mt-2">
        <p className="text-amber-950/80 dark:text-amber-100/80">底图强度</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {INTENSITY_STEPS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onIntensity(v)}
              className={`rounded-md border px-2 py-0.5 ${
                Math.abs(intensity - v) < 0.01
                  ? "border-amber-700 bg-amber-700 text-white"
                  : "border-amber-300 bg-white/70 text-amber-900 dark:border-amber-600/50 dark:bg-amber-900/50 dark:text-amber-100"
              }`}
            >
              {v.toFixed(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2">
        <p className="text-amber-950/80 dark:text-amber-100/80">页面纱层</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {VEIL_STEPS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVeil(v)}
              className={`rounded-md border px-2 py-0.5 ${
                Math.abs(veil - v) < 0.01
                  ? "border-amber-700 bg-amber-700 text-white"
                  : "border-amber-300 bg-white/70 text-amber-900 dark:border-amber-600/50 dark:bg-amber-900/50 dark:text-amber-100"
              }`}
            >
              {v.toFixed(2)}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-2 text-amber-950/70 dark:text-amber-100/70">当前：{summary}</p>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(summary).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => setCopied(false),
          );
        }}
        className="mt-1 rounded-md border border-amber-700 bg-amber-700 px-2 py-0.5 text-white"
      >
        {copied ? "已复制" : "复制数值"}
      </button>
    </div>
  );
}
