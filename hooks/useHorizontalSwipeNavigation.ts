"use client";

import { useEffect, useRef } from "react";

const WHEEL_TRIGGER = 40;
const WHEEL_COOLDOWN_MS = 500;
const TOUCH_AXIS_LOCK = 10;
const TOUCH_TRIGGER = 50;

/**
 * 顶部内容的左右切换：触屏横滑、触控板横滚都算。
 * 与 /blog 的 useTabSwipeNavigation 分开，因为这里切的是路由而不是页内 tab。
 */
function isInteractive(target: EventTarget | null): boolean {
  return !!(
    target as Element | null
  )?.closest?.(
    "input, textarea, select, [contenteditable='true'], [data-pet-chat], [data-hscroll], pre, code",
  );
}

export function useHorizontalSwipeNavigation({
  onPrev,
  onNext,
  enabled = true,
}: {
  onPrev: () => void;
  onNext: () => void;
  enabled?: boolean;
}) {
  const prevRef = useRef(onPrev);
  const nextRef = useRef(onNext);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    prevRef.current = onPrev;
    nextRef.current = onNext;
    enabledRef.current = enabled;
  }, [onPrev, onNext, enabled]);

  useEffect(() => {
    let wheelAccum = 0;
    let lastTriggerAt = 0;
    let lastDir: 1 | -1 | 0 = 0;

    function trigger(dir: 1 | -1) {
      if (!enabledRef.current) return;
      if (dir > 0) nextRef.current();
      else prevRef.current();
    }

    function onWheel(e: WheelEvent) {
      if (isInteractive(e.target)) return;
      if (!(Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 2)) return;
      e.preventDefault();

      const now = performance.now();
      const dir: 1 | -1 = e.deltaX > 0 ? 1 : -1;
      // 同一方向的惯性滚动只算一次；反向手势立即生效
      if (lastDir !== 0 && dir === lastDir && now - lastTriggerAt < WHEEL_COOLDOWN_MS) {
        wheelAccum = 0;
        return;
      }
      if (wheelAccum !== 0 && Math.sign(wheelAccum) !== dir) wheelAccum = 0;
      wheelAccum += e.deltaX;
      if (Math.abs(wheelAccum) >= WHEEL_TRIGGER) {
        trigger(dir);
        lastTriggerAt = now;
        lastDir = dir;
        wheelAccum = 0;
      }
    }

    let startX = 0;
    let startY = 0;
    let horizontal: boolean | null = null;
    let exempt = false;

    function onTouchStart(e: TouchEvent) {
      startX = e.touches[0]?.clientX ?? 0;
      startY = e.touches[0]?.clientY ?? 0;
      horizontal = null;
      exempt = isInteractive(e.target);
    }

    function onTouchMove(e: TouchEvent) {
      if (exempt || horizontal === false) return;
      const dx = (e.touches[0]?.clientX ?? startX) - startX;
      const dy = (e.touches[0]?.clientY ?? startY) - startY;
      if (
        horizontal === null &&
        (Math.abs(dx) > TOUCH_AXIS_LOCK || Math.abs(dy) > TOUCH_AXIS_LOCK)
      ) {
        horizontal = Math.abs(dx) > Math.abs(dy);
      }
      if (horizontal) e.preventDefault();
    }

    function onTouchEnd(e: TouchEvent) {
      if (exempt || !horizontal) return;
      const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
      if (Math.abs(dx) > TOUCH_TRIGGER) trigger(dx < 0 ? 1 : -1);
    }

    document.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
    document.documentElement.style.overscrollBehaviorX = "none";

    return () => {
      document.removeEventListener("wheel", onWheel);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.documentElement.style.overscrollBehaviorX = "";
    };
  }, []);
}
