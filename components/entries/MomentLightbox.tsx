"use client";

import { useCallback, useEffect, useState } from "react";

export function MomentLightbox({
  urls,
  index,
  open,
  onClose,
}: {
  urls: string[];
  index: number;
  open: boolean;
  onClose: () => void;
}) {
  const [i, setI] = useState(index);
  // 加载失败的页（坏图、被当作图片的视频）显示提示，不留一页空白
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      if (e.key === "ArrowRight") setI((x) => Math.min(urls.length - 1, x + 1));
    },
    [open, onClose, urls.length]
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || urls.length === 0) return null;

  const src = urls[i];
  if (!src) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/92 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      {/* 点图片以外的任何地方都关闭：内容层不接收点击（pointer-events-none），点击落到这层背景上 */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="absolute inset-0 cursor-default border-0 bg-transparent"
        onClick={onClose}
      />
      <button
        type="button"
        className="absolute right-3 top-3 z-20 rounded-full bg-white/10 p-2 text-white backdrop-blur-sm transition-colors hover:bg-white/20 sm:right-5 sm:top-5"
        onClick={onClose}
        aria-label="关闭"
      >
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <div className="pointer-events-none relative z-10 flex max-h-[min(92vh,900px)] max-w-[min(96vw,1200px)] flex-1 items-center justify-center">
        {urls.length > 1 && (
          <button
            type="button"
            className="pointer-events-auto absolute left-0 top-1/2 z-20 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white backdrop-blur-sm disabled:opacity-30 sm:left-2"
            disabled={i <= 0}
            onClick={(e) => {
              e.stopPropagation();
              setI((x) => Math.max(0, x - 1));
            }}
            aria-label="上一张"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        <div className="relative mx-10 flex max-h-full w-full justify-center">
          {failed.has(src) ? (
            <p className="py-24 text-center text-sm text-white/70">图片无法加载</p>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- 外链原图尺寸不定
            <img
              src={src}
              alt=""
              className="pointer-events-auto max-h-[min(92vh,900px)] w-auto max-w-full object-contain"
              onError={() => setFailed((prev) => new Set(prev).add(src))}
            />
          )}
        </div>
        {urls.length > 1 && (
          <button
            type="button"
            className="pointer-events-auto absolute right-0 top-1/2 z-20 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white backdrop-blur-sm disabled:opacity-30 sm:right-2"
            disabled={i >= urls.length - 1}
            onClick={(e) => {
              e.stopPropagation();
              setI((x) => Math.min(urls.length - 1, x + 1));
            }}
            aria-label="下一张"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        <p className="absolute bottom-2 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/90">
          {i + 1} / {urls.length}
        </p>
      </div>
    </div>
  );
}
