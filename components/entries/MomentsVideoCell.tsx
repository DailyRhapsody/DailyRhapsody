"use client";

import { useState } from "react";

/** 动态视频懒加载：默认只渲染缩略图占位 + 播放图标，
 *  避免 iOS Safari 在 mount `<video>` + 加载元数据时抢占音频会话，
 *  从而中断 StickyProfileHeader 里正在播放的背景音乐。
 *  用户点击后才插入真正的 <video> 并自动播放。 */
export function MomentsVideoCell({
  src,
  posterUrl,
  compact = false,
}: {
  src: string;
  posterUrl?: string;
  /** 动态流里和图片同尺寸的方格；不传时保留原来的大图模式 */
  compact?: boolean;
}) {
  const [activated, setActivated] = useState(false);
  if (activated) {
    return (
      <video
        src={src}
        poster={posterUrl}
        className={
          compact
            ? "h-full w-full object-contain"
            : "max-h-[min(70vh,520px)] w-full object-contain"
        }
        controls
        playsInline
        autoPlay
        muted
        preload="metadata"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setActivated(true)}
      className={compact ? "relative block aspect-square w-full overflow-hidden rounded-lg bg-zinc-900" : "relative block w-full"}
      aria-label="播放视频"
    >
      <video
        src={src}
        poster={posterUrl}
        muted
        playsInline
        preload="metadata"
        className={
          compact
            ? "h-full w-full object-cover"
            : "max-h-[min(70vh,520px)] w-full object-contain bg-zinc-900"
        }
      />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className={compact ? "flex h-10 w-10 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm" : "flex h-14 w-14 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm"}>
          <svg viewBox="0 0 24 24" className={compact ? "h-5 w-5 text-white" : "h-7 w-7 text-white"} fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </span>
    </button>
  );
}
