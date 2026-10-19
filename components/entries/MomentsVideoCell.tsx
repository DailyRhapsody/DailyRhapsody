"use client";

import { useRef, useState } from "react";

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
  const [playing, setPlaying] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  if (activated && compact) {
    return (
      <div className="relative h-full w-full overflow-hidden rounded-lg bg-zinc-900">
        <video
          ref={videoRef}
          src={src}
          poster={posterUrl}
          className="h-full w-full object-cover"
          playsInline
          autoPlay
          muted
          preload="metadata"
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "暂停视频" : "播放视频"}
          className="absolute bottom-2 left-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-apple hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          {playing ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
      </div>
    );
  }

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
