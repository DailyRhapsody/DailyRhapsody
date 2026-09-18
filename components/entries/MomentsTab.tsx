"use client";

import { type RefObject } from "react";
import { MomentsVideoCell } from "./MomentsVideoCell";
import { momentsGridClass } from "./utils";
import type { MomentsTimelineRow } from "./types";

/** 把 ISO 字符串渲染成本地 YYYY-MM-DD（按本地时区，不含时分秒） */
function formatMomentDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type MomentsLightboxOpen = {
  urls: string[];
  i: number;
  lbKey: string;
};

export function MomentsTab({
  timeline,
  loading,
  hasMore,
  loadingMore,
  sentinelRef,
  onOpenLightbox,
}: {
  timeline: MomentsTimelineRow[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  sentinelRef: RefObject<HTMLDivElement | null>;
  onOpenLightbox: (lb: MomentsLightboxOpen) => void;
}) {
  return (
    <section className="pt-2">
      {loading && timeline.length === 0 && (
        <div className="space-y-6 px-4 py-8">
          {[1, 2, 3].map((k) => (
            <div key={k} className="animate-pulse space-y-3">
              <div className="h-3 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="grid grid-cols-3 gap-1">
                <div className="aspect-square rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="aspect-square rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="aspect-square rounded bg-zinc-200 dark:bg-zinc-700" />
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && timeline.length === 0 && (
        <p className="px-4 py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
          暂无内容
        </p>
      )}
      {timeline.map((row) => {
        const m = row.moment;
        const sorted = [...m.media].sort((a, b) => a.sortOrder - b.sortOrder);
        const urls = sorted.map((x) => x.url);

        if (m.type === 2 && sorted[0]) {
          return (
            <article
              key={row.rowKey}
              id={row.rowKey}
              className="scroll-mt-24 border-b border-zinc-100 px-3 py-4 dark:border-zinc-800/50 sm:px-4"
            >
              <p className="mb-2 text-[13px] leading-none text-zinc-400 dark:text-zinc-500">
                {formatMomentDate(m.createdAt)}
              </p>
              <div className="overflow-hidden rounded bg-black">
                <MomentsVideoCell
                  src={sorted[0].url}
                  posterUrl={sorted[0].thumbUrl || undefined}
                />
              </div>
            </article>
          );
        }

        if (sorted.length === 0) return null;
        const n = sorted.length;
        return (
          <article
            key={row.rowKey}
            id={row.rowKey}
            className="scroll-mt-24 border-b border-zinc-100 px-3 py-4 dark:border-zinc-800/50 sm:px-4"
          >
            <p className="mb-2 text-[13px] leading-none text-zinc-400 dark:text-zinc-500">
              {formatMomentDate(m.createdAt)}
            </p>
            <div className={`grid ${momentsGridClass(n)} ${n <= 1 ? "" : "gap-0.5"}`}>
              {sorted.map((media, idx) => {
                // n===1：让 <img> 走自然流，按图片原始比例自撑高（封顶 72vh），
                // 之前用 absolute + aspect-auto 会让父按钮高度坍成 0，肉眼就是一片空白。
                // n>=2：网格强制方形（aspect-square），<img> 绝对定位填满。
                if (n === 1) {
                  return (
                    <button
                      key={`${media.url}-${idx}`}
                      type="button"
                      className="block w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
                      onClick={() =>
                        onOpenLightbox({ urls, i: idx, lbKey: `${row.rowKey}-${idx}` })
                      }
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={media.thumbUrl || media.url}
                        alt=""
                        className="block h-auto max-h-[min(72vh,640px)] w-full object-contain"
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                  );
                }
                return (
                  <button
                    key={`${media.url}-${idx}`}
                    type="button"
                    className="relative aspect-square w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
                    onClick={() =>
                      onOpenLightbox({ urls, i: idx, lbKey: `${row.rowKey}-${idx}` })
                    }
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={media.thumbUrl || media.url}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  </button>
                );
              })}
            </div>
          </article>
        );
      })}
      {hasMore && <div ref={sentinelRef} className="h-8" aria-hidden />}
      {loadingMore && (
        <div className="flex justify-center py-6">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
        </div>
      )}
    </section>
  );
}
