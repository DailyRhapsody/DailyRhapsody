"use client";

import { useEffect, useRef, useState } from "react";

const MAX_EGG_PULL = 120;
/** 滚轮停止后多久收起彩蛋（鼠标滚轮没有 touchend 信号，要靠 timer 兜底） */
const WHEEL_RELEASE_MS = 100;
/** 距离页底多少像素就算"到底"，留 80px 余量避免亚像素抖动 */
const BOTTOM_THRESHOLD = 80;
/** 收起动画的反弹时长，与 transition-apple 的 400ms 对齐 */
const REBOUND_MS = 400;

export type UseEggPullToRefresh = {
  /** 当前累计的下拉位移（px）。0 表示未触发或已收起 */
  eggPullY: number;
  /** 收起阶段：消费者可用它给容器加 transition 让回弹更顺滑 */
  isRebounding: boolean;
};

/**
 * 文章列表底部"再滚一下出彩蛋"的下拉刷新交互。
 *
 * 触发条件（必须同时满足）：
 *   1. 当前已经是最后一页（`enabled=true`，由调用方根据 `!hasMore && total>0` 计算）
 *   2. 用户已经把页面滚到接近页底
 *   3. 继续往下滚 / 往下滑（deltaY > 0）
 *
 * 一旦中断（手指松开 / 滚轮停转 / 反向滚动），就把 eggPullY 弹回 0。
 *
 * 内部用 ref 而不是直接闭包 enabled，是因为 wheel/touch 监听器只在挂载时注册一次，
 * 闭包里读到的会是初次渲染时的旧值；用 ref + useEffect 同步可以保证读到最新。
 */
export function useEggPullToRefresh(enabled: boolean): UseEggPullToRefresh {
  const [eggPullY, setEggPullY] = useState(0);
  const [isRebounding, setIsRebounding] = useState(false);

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const pullAccumRef = useRef(0);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchLastYRef = useRef(0);

  useEffect(() => {
    let rafId = 0;

    const isAtBottom = () => {
      const scrollTop = window.scrollY ?? document.documentElement.scrollTop;
      const scrollHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      return scrollTop + window.innerHeight >= scrollHeight - BOTTOM_THRESHOLD;
    };

    const hideEgg = () => {
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      pullAccumRef.current = 0;
      setIsRebounding(true);
      setEggPullY(0);
      releaseTimerRef.current = setTimeout(() => {
        setIsRebounding(false);
        releaseTimerRef.current = null;
      }, REBOUND_MS);
    };

    const flushPullY = () => {
      rafId = 0;
      setEggPullY(pullAccumRef.current);
    };

    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current) return;
      // 在时间轴上滚轮滚的是时间轴本身，不累计彩蛋拉力
      if ((e.target as Element | null)?.closest?.("[data-scroll-timeline]")) return;
      if (!isAtBottom()) return;
      if (e.deltaY === 0) return;

      // 仅在底部「继续往下滚」时累计彩蛋；向上滚用 deltaY<0，之前误用 abs 会把上滑也算成拉力
      if (e.deltaY < 0) {
        if (releaseTimerRef.current) {
          clearTimeout(releaseTimerRef.current);
          releaseTimerRef.current = null;
        }
        pullAccumRef.current = 0;
        setEggPullY(0);
        setIsRebounding(false);
        return;
      }

      pullAccumRef.current = Math.min(
        MAX_EGG_PULL,
        pullAccumRef.current + e.deltaY,
      );
      if (!rafId) rafId = requestAnimationFrame(flushPullY);
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = setTimeout(hideEgg, WHEEL_RELEASE_MS);
    };

    const onTouchStart = () => {
      touchLastYRef.current = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!enabledRef.current) return;
      if (!isAtBottom()) return;
      const y = e.touches[0]?.clientY ?? 0;
      if (touchLastYRef.current === 0) touchLastYRef.current = y;
      const dy = y - touchLastYRef.current;
      touchLastYRef.current = y;
      if (dy < 0) {
        pullAccumRef.current = 0;
        setEggPullY(0);
        setIsRebounding(false);
        return;
      }
      if (dy > 0) {
        pullAccumRef.current = Math.min(
          MAX_EGG_PULL,
          pullAccumRef.current + dy,
        );
        if (!rafId) rafId = requestAnimationFrame(flushPullY);
      }
    };
    const onTouchEnd = () => {
      hideEgg();
    };

    document.addEventListener("wheel", onWheel, { passive: true, capture: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      if (rafId) cancelAnimationFrame(rafId);
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    };
  }, []);

  return { eggPullY, isRebounding };
}
