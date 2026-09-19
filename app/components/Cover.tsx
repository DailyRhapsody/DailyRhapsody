"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const AUTO_ENTER_MS = 3000;

type ProfileCover = {
  homeCoverUrl?: string;
  homeCoverIsVideo?: boolean;
};

export default function Cover() {
  const router = useRouter();
  const [cover, setCover] = useState<ProfileCover | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((p: ProfileCover | null) => {
        if (!cancelled && p) setCover(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 封面停留超过 AUTO_ENTER_MS 且无操作则进入文章列表；任意交互则取消 */
  useEffect(() => {
    let done = false;
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      router.replace("/blog");
    }, AUTO_ENTER_MS);

    const cancel = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
    };

    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("pointerdown", cancel, opts);
    window.addEventListener("wheel", cancel, opts);
    window.addEventListener("keydown", cancel, { capture: true });

    return () => {
      cancel();
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [router]);

  const mediaUrl = cover?.homeCoverUrl?.trim();
  const useVideo = Boolean(mediaUrl && cover?.homeCoverIsVideo);
  const useCustomImage = Boolean(mediaUrl && !cover?.homeCoverIsVideo);

  return (
    <header className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-zinc-900">
      {/* 背景：后台可配置图片或视频，否则默认图 */}
      <div className="absolute inset-0">
        {useVideo ? (
          <video
            src={mediaUrl}
            className="absolute inset-0 h-full w-full object-cover"
            autoPlay
            muted
            loop
            playsInline
            aria-hidden
          />
        ) : useCustomImage ? (
          <Image
            src={mediaUrl!}
            alt=""
            fill
            className="object-cover"
            priority
            sizes="100vw"
            unoptimized={mediaUrl!.startsWith("http")}
          />
        ) : (
          // 与文章页顶栏同一张无损原图（NASA 哈勃极深场 XDF）；不走图片优化，否则会被转成有损格式。
          // 原图星系太密会抢走标题和导航的注意力，首页做成磨砂：模糊后只留星空色彩，放大一点盖住模糊后变淡的边缘
          <Image
            src="/hubble-xdf.webp"
            alt=""
            fill
            className="scale-[1.06] object-cover blur-[12px]"
            priority
            sizes="100vw"
            unoptimized
          />
        )}
        <div
          className={`absolute inset-0 ${useVideo || useCustomImage ? "bg-black/40" : "bg-black/50"}`}
          aria-hidden
        />
      </div>

      {/* 标题 + 导航 */}
      <div className="relative z-10 flex flex-col items-center px-4 text-white">
        <h1 className="text-center text-5xl font-semibold tracking-tight drop-shadow-lg sm:text-7xl md:text-8xl">
          DailyRhapsody
        </h1>
        <p className="mt-4 text-sm tracking-[0.2em] opacity-90 sm:text-base">
          I think, therefore I am.
        </p>
        <nav
          className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm tracking-wide"
          aria-label="Primary"
        >
          <Link
            href="/blog"
            className="rounded transition-opacity duration-200 ease-out hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-transparent"
          >
            Blog
          </Link>
          <span className="text-white/50" aria-hidden>·</span>
          <Link
            href="/moments"
            className="rounded transition-opacity duration-200 ease-out hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-transparent"
          >
            Moments
          </Link>
          <span className="text-white/50" aria-hidden>·</span>
          <Link
            href="/reference"
            className="rounded transition-opacity duration-200 ease-out hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-transparent"
          >
            Reference
          </Link>
          <span className="text-white/50" aria-hidden>·</span>
          <Link
            href="/about"
            className="rounded transition-opacity duration-200 ease-out hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-transparent"
          >
            About
          </Link>
        </nav>
      </div>

      {/* 进入博客列表 - 苹果风：带圈、透明背景、细边框 */}
      <Link
        href="/blog"
        className="absolute bottom-8 left-1/2 z-10 flex h-11 w-11 -translate-x-1/2 items-center justify-center rounded-full border border-white/40 bg-transparent text-white/80 transition-all duration-200 ease-out hover:scale-105 hover:border-white/70 hover:bg-white/20 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-transparent"
        aria-label="Enter blog"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </Link>
    </header>
  );
}
