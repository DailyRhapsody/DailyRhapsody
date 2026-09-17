"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import AvatarLifeRing from "@/components/AvatarLifeRing";

export type StickyProfileHeaderData = {
  name: string;
  signature: string;
  avatar: string;
  /** 未设置时使用默认 `/header-bg.png` */
  headerBg?: string;
};

/**
 * 与 /entries 文章列表页一致的粘性顶栏：背景图、滚动收缩、点击栏展开、头像与签名。
 * 传入 `entriesBgmSrc` 时（仅文章页）：进入后尝试播放该音频，头像慢转；点头像暂停/继续，点昵称回首页。
 */
export default function StickyProfileHeader({
  profile,
  entriesBgmSrc,
}: {
  profile: StickyProfileHeaderData | null;
  /** 文章页背景音乐 URL（如 `/audio/houlai-dewomen.mp3`）；不传则头像仍可点进首页 */
  entriesBgmSrc?: string;
}) {
  const [scrollY, setScrollY] = useState(0);
  const [isReturnToTopAnimating, setIsReturnToTopAnimating] = useState(false);
  const [bgmPlaying, setBgmPlaying] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const returnToTopPhaseRef = useRef<0 | 1 | 2>(0);
  const returnToTopRafRef = useRef<number>(0);
  const collapsedBarRef = useRef<HTMLDivElement>(null);
  const expandedContentRef = useRef<HTMLDivElement>(null);

  const hasEntriesBgm = Boolean(entriesBgmSrc?.trim());

  /**
   * 刷新/进入页后尽量自动播放。
   * 策略 1: 直接有声播放（浏览器记住了交互历史时能成功）
   * 策略 2: 静音播放 + 等首次交互后解除静音（保证音乐「在播」，头像转动）
   * 策略 3: 等首次交互后播放（极端情况 fallback）
   *
   * 注意：交互监听器在对应策略成功/失败后才注册，避免异步间隙被提前消耗。
   */
  const tryAutoplayBgm = useCallback(async () => {
    const a = audioRef.current;
    if (!a || !hasEntriesBgm) return;
    if (!a.paused) return;

    const INTERACTION_EVENTS = ["click", "touchstart", "keydown", "scroll"] as const;

    /** 注册「首次交互解除静音」——仅在策略 2 静音播放成功后使用 */
    function registerUnmute() {
      const handler = () => {
        if (!a) return;
        a.muted = false;
        // 如果音频在静音播放期间因 buffer stall、浏览器策略、页面切换等原因暂停了，
        // 仅 unmute 不会恢复播放，需要显式 play()。
        if (a.paused) {
          void a.play().catch(() => { /* 极端情况播放仍失败，静默忽略 */ });
        }
        for (const evt of INTERACTION_EVENTS) {
          window.removeEventListener(evt, handler, true);
        }
      };
      for (const evt of INTERACTION_EVENTS) {
        window.addEventListener(evt, handler, { capture: true });
      }
    }

    /** 注册「首次交互开始播放」——仅在策略 1+2 都失败后使用；
     *  play 可能再失败（音频未就绪），此时不移除监听器，等下次交互重试 */
    function registerPlay() {
      const handler = () => {
        if (!a) return;
        void a.play()
          .then(() => {
            for (const evt of INTERACTION_EVENTS) {
              window.removeEventListener(evt, handler, true);
            }
          })
          .catch(() => { /* 保留监听器，下次交互再试 */ });
      };
      for (const evt of INTERACTION_EVENTS) {
        window.addEventListener(evt, handler, { capture: true });
      }
    }

    // 策略 1: 直接有声播放
    try {
      await a.play();
      return;
    } catch { /* 浏览器阻止了，继续 */ }

    // 策略 2: 静音播放（浏览器允许静音自动播放）
    try {
      a.muted = true;
      await a.play();
      // 静音播放成功 — 音乐在播，头像转动，等交互后解除静音
      registerUnmute();
      return;
    } catch {
      a.muted = false;
    }

    // 策略 3: 连静音都失败了，等交互后直接播放
    registerPlay();
  }, [hasEntriesBgm]);

  const toggleBgm = useCallback(() => {
    const a = audioRef.current;
    if (!a || !hasEntriesBgm) return;
    if (a.paused) {
      void a.play()
        .then(() => setBgmPlaying(true))
        .catch(() => setBgmPlaying(false));
    } else {
      a.pause();
      setBgmPlaying(false);
    }
  }, [hasEntriesBgm]);

  useEffect(() => {
    if (!hasEntriesBgm) return;
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setBgmPlaying(true);
    const onPause = () => setBgmPlaying(false);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, [hasEntriesBgm]);

  useEffect(() => {
    if (!hasEntriesBgm) return;

    const kick = () => {
      void tryAutoplayBgm();
    };

    // 等 <audio> ref 挂上后再播；缓冲就绪 canplay 再试；刷新时 pageshow 再试
    let raf0 = 0;
    let raf1 = 0;
    raf0 = requestAnimationFrame(() => {
      raf1 = requestAnimationFrame(() => {
        kick();
        audioRef.current?.addEventListener("canplay", kick, { once: true });
      });
    });

    const onPageShow = () => {
      kick();
    };
    window.addEventListener("pageshow", onPageShow);

    return () => {
      cancelAnimationFrame(raf0);
      cancelAnimationFrame(raf1);
      window.removeEventListener("pageshow", onPageShow);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      audioRef.current?.removeEventListener("canplay", kick);
    };
  }, [hasEntriesBgm, tryAutoplayBgm, entriesBgmSrc]);

  const runReturnToTop = useCallback(() => {
    if (typeof window === "undefined") return;
    if (returnToTopPhaseRef.current !== 0) return;
    const startY = window.scrollY;
    if (startY <= 0) return;

    const HEADER_EXPANDED = 260;
    const HEADER_COLLAPSED = 56;
    const header = headerRef.current!;

    returnToTopPhaseRef.current = 1;

    // Kill CSS transitions — rAF drives everything
    header.style.transition = "none";
    document.documentElement.style.overflowAnchor = "none";
    // 动画不可中断，时间轴跳转看到这个标记会等它结束再滚（见 EntriesTimeline）
    document.documentElement.dataset.returnToTop = "1";
    const collapsedEl = collapsedBarRef.current;
    const expandedEl = expandedContentRef.current;
    if (collapsedEl) collapsedEl.style.transition = "none";
    if (expandedEl) {
      expandedEl.style.transition = "none";
      expandedEl.style.opacity = "0";
      expandedEl.style.transform = "translateY(4px)";
    }

    flushSync(() => {
      setIsReturnToTopAnimating(true);
    });

    const scrollDuration = Math.min(
      1400,
      400 + 200 * Math.log(1 + startY / 200),
    );
    let startT = 0;

    function easeInOutCubic(x: number) {
      return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
    }
    function easeOutCubic(x: number) {
      return 1 - (1 - x) ** 3;
    }

    // Phase 1: scroll to top only (no height changes — scrollTo works reliably)
    function scrollTick(now: number) {
      if (!startT) startT = now;
      const elapsed = now - startT;
      const progress = Math.max(0, Math.min(elapsed / scrollDuration, 1));
      const eased = easeInOutCubic(progress);

      window.scrollTo({ top: Math.round(startY * (1 - eased)), behavior: "instant" });

      if (progress < 1) {
        returnToTopRafRef.current = requestAnimationFrame(scrollTick);
      } else {
        window.scrollTo({ top: 0, behavior: "instant" });

        // Phase 2: expand header + crossfade (no scrollTo — overflow-anchor:none prevents drift)
        returnToTopPhaseRef.current = 2;
        const EXPAND_MS = 400;
        let expandStart = 0;

        function expandTick(now: number) {
          if (!expandStart) expandStart = now;
          const elapsed = now - expandStart;
          const p = Math.max(0, Math.min(elapsed / EXPAND_MS, 1));
          const eased = easeOutCubic(p);

          const h = HEADER_COLLAPSED + (HEADER_EXPANDED - HEADER_COLLAPSED) * eased;
          header.style.height = `${h}px`;

          // Crossfade: collapsed bar out, expanded content in
          if (collapsedEl) {
            collapsedEl.style.opacity = `${1 - eased}`;
            if (eased > 0.5) collapsedEl.style.pointerEvents = "none";
          }
          if (expandedEl) {
            expandedEl.style.opacity = `${eased}`;
            expandedEl.style.transform = `translateY(${(1 - eased) * 4}px)`;
          }

          if (p < 1) {
            returnToTopRafRef.current = requestAnimationFrame(expandTick);
          } else {
            header.style.height = `${HEADER_EXPANDED}px`;

            flushSync(() => {
              setScrollY(0);
              setIsReturnToTopAnimating(false);
            });

            // Clear inline overrides — CSS classes now match final state
            if (collapsedEl) {
              collapsedEl.style.opacity = "";
              collapsedEl.style.pointerEvents = "";
              collapsedEl.style.transition = "";
            }
            if (expandedEl) {
              expandedEl.style.opacity = "";
              expandedEl.style.transform = "";
              expandedEl.style.transition = "";
            }

            // Next frame: re-enable CSS transitions and unlock
            returnToTopRafRef.current = requestAnimationFrame(() => {
              window.scrollTo({ top: 0, behavior: "instant" });
              header.style.transition = "";
              document.documentElement.style.overflowAnchor = "";
              delete document.documentElement.dataset.returnToTop;
              returnToTopPhaseRef.current = 0;
            });
          }
        }

        returnToTopRafRef.current = requestAnimationFrame(expandTick);
      }
    }

    returnToTopRafRef.current = requestAnimationFrame(scrollTick);
  }, []);

  useEffect(() => {
    let scrollRaf = 0;
    function onScroll() {
      if (returnToTopPhaseRef.current !== 0) return;
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        setScrollY(typeof window !== "undefined" ? window.scrollY : 0);
      });
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (returnToTopRafRef.current) cancelAnimationFrame(returnToTopRafRef.current);
      // 回顶动画中途卸载（如点「首页」离开）：html 在客户端路由间保留，清掉动画留下的全局状态
      if (returnToTopPhaseRef.current !== 0) {
        returnToTopPhaseRef.current = 0;
        delete document.documentElement.dataset.returnToTop;
        document.documentElement.style.overflowAnchor = "";
      }
    };
  }, []);

  const HEADER_EXPANDED = 260;
  const HEADER_COLLAPSED = 56;
  const threshold = HEADER_EXPANDED - HEADER_COLLAPSED;
  const COLLAPSE_AT = threshold + 10;
  const nearTop = scrollY < 28;
  const isReturning = isReturnToTopAnimating;
  const signatureTrimmed = profile?.signature?.trim() ?? "";
  const hasSignature = signatureTrimmed.length > 0;

  const height = isReturning
    ? HEADER_COLLAPSED
    : nearTop
      ? HEADER_EXPANDED
      : Math.max(HEADER_COLLAPSED, HEADER_EXPANDED - scrollY);
  const isCollapsed = isReturning || scrollY >= COLLAPSE_AT;

  // headerBg 会被插进 CSS `url(...)`，只放行站内相对路径和 http(s)，
  // 挡掉 javascript: / data: 之类的协议注入。
  const rawBgUrl = profile?.headerBg?.trim() || "/header-bg.png";
  const bgUrl = (() => {
    if (rawBgUrl.startsWith("/")) return rawBgUrl;
    try {
      const { protocol } = new URL(rawBgUrl);
      if (protocol === "https:" || protocol === "http:") return rawBgUrl;
    } catch {
      /* 非法 URL，落到兜底图 */
    }
    return "/header-bg.png";
  })();

  function renderAvatar(size: "sm" | "lg") {
    const ring = (
      <AvatarLifeRing
        src={profile?.avatar || "/avatar.png"}
        size={size}
        spinState={
          hasEntriesBgm ? (bgmPlaying ? "running" : "paused") : "off"
        }
      />
    );
    if (!hasEntriesBgm) {
      return (
        <Link href="/" className="shrink-0 leading-none" aria-label="首页">
          {ring}
        </Link>
      );
    }
    return (
      <button
        type="button"
        className="shrink-0 cursor-pointer leading-none"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleBgm();
        }}
        aria-label={bgmPlaying ? "暂停音乐" : "播放音乐"}
      >
        {ring}
      </button>
    );
  }

  return (
    <header
      ref={headerRef}
      className={`sticky top-0 z-30 w-full overflow-hidden rounded-b-2xl bg-gradient-to-b from-zinc-900 via-zinc-800 to-black transition-[height] ease-out ${
        isReturning ? "duration-0" : "duration-300"
      }`}
      style={{
        height: `${height}px`,
      }}
    >
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url(${bgUrl})`,
        }}
      />
      <div className="absolute inset-0 bg-black/50" />
      {/* 始终在 DOM，用 visibility 控制显隐，保持 sm 头像 CSS 动画与 lg 同步 */}
        <div
          ref={collapsedBarRef}
          className={`absolute inset-0 z-10 flex items-stretch justify-center px-5 ${
            isCollapsed ? "visible" : "invisible pointer-events-none"
          }`}
        >
          <button
            type="button"
            className="h-full min-w-0 flex-1 cursor-pointer"
            onClick={runReturnToTop}
            aria-label="回到顶部并展开（左侧区域）"
          />
          <div className="pointer-events-none flex shrink-0 items-center gap-2 py-0">
            <span className="pointer-events-auto">{renderAvatar("sm")}</span>
            <Link
              href="/"
              className="pointer-events-auto inline-flex min-w-0 w-fit self-center"
              aria-label="首页"
            >
              <p className="whitespace-nowrap text-base font-bold leading-tight text-white">
                {profile?.name ?? "DailyRhapsody"}
              </p>
            </Link>
          </div>
          <button
            type="button"
            className="h-full min-w-0 flex-1 cursor-pointer"
            onClick={runReturnToTop}
            aria-label="回到顶部并展开（右侧区域）"
          />
        </div>
      <div className="relative flex h-full w-full flex-col justify-center px-5">
        <div
          ref={expandedContentRef}
          className={`min-w-0 flex-1 transition-[transform,opacity] duration-400 ease-out ${
            isCollapsed && !isReturning
              ? "translate-y-1 opacity-0 pointer-events-none"
              : "flex flex-col justify-center translate-y-0 opacity-100"
          }`}
        >
          <div
            className="inline-flex w-fit max-w-full shrink-0 items-center gap-4 self-start"
          >
            {renderAvatar("lg")}
            <div
              className="flex min-w-0 flex-col justify-center gap-1"
            >
              <Link
                href="/"
                className="inline-flex w-fit self-start"
              >
                <p className="whitespace-nowrap text-lg font-bold text-white">
                  {profile?.name ?? "DailyRhapsody"}
                </p>
              </Link>
              {hasSignature && (
                <p className="max-w-[min(100%,calc(100vw-6rem))] self-start text-left text-xs leading-snug text-white/80">
                  {signatureTrimmed}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
      {hasEntriesBgm && entriesBgmSrc && (
        <audio
          ref={audioRef}
          src={entriesBgmSrc.trim()}
          loop
          playsInline
          preload="auto"
          className="pointer-events-none absolute h-0 w-0 opacity-0"
          aria-hidden
        />
      )}
    </header>
  );
}
