"use client";

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

/** 一旦累计到这个 deltaX 就立刻切 tab —— 不再等 wheel 停下 */
const WHEEL_TRIGGER_DELTA = 40;
/** 触发后，等横向 wheel 安静这么久才允许下一次切。
 *  trackpad 松手后惯性会继续吐 deltaX；只靠固定 300ms 冷却时，
 *  一次轻扫可能在惯性尾声再切一格（0→1→2），手感像“滑一下跳两张卡”。 */
const WHEEL_GESTURE_IDLE_MS = 280;
const TOUCH_AXIS_LOCK_DELTA = 10;
const TOUCH_TRIGGER_DELTA = 50;

/**
 * 监听挂在 document 上，React 里 stopPropagation 挡不住，只能按目标元素豁免。
 * - data-pet-chat：AI-Persona 面板自己处理交互。
 * - data-hscroll：自身要横向滚动的容器（/blog 顶部卡片条）。触屏横滑在这里被
 *   preventDefault 会让容器永远滑不动，四张卡在窄屏只剩前两张可达。
 */
function isExempt(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.("[data-pet-chat], [data-hscroll]");
}

/**
 * 让任意位置的横向滚轮（trackpad / 鼠标横滚）和触屏左右滑动都能切顶部 tab。
 *
 * 顺手做两件事：
 * 1. 屏蔽浏览器自带的左右滑动导航（Safari/Chrome 在 macOS 上的「← / →」回退/前进），
 *    通过 `overscroll-behavior-x: none` + 在判定为水平滑动的 touchmove 上 preventDefault。
 * 2. 触屏 touchmove 一旦判定为水平滑动就吃掉竖向滚动，避免边滑边滚出现的「滑歪」体验。
 *
 * 之前这一坨在 entries/page.tsx 里有 60+ 行，跟其他 6 个 useEffect 缠在一起，抽出来后
 * page 那一侧只剩一行 hook 调用。
 */
export function useTabSwipeNavigation(
  setTab: Dispatch<SetStateAction<number>>,
  {
    min = 0,
    max = 1,
    enabled = true,
  }: {
    min?: number;
    max?: number;
    /** false 时不切 tab（如灯箱打开），但仍拦截横滑，避免触发浏览器前进/后退 */
    enabled?: boolean;
  } = {},
) {
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    let wheelAccum = 0;

    /** 触发过一次切换后，等横向 wheel 安静下来才解锁，避免惯性再切一格 */
    let wheelLocked = false;
    let wheelUnlockTimer: ReturnType<typeof setTimeout> | null = null;

    function onWheel(e: WheelEvent) {
      // AI-Persona 面板里的横滚、卡片条自身的横滚都留给它们自己
      if (isExempt(e.target)) return;
      // 只关心横向意图：deltaX 的绝对值要大于 deltaY 才算横滚
      if (!(Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 2)) return;
      e.preventDefault();

      // 每次横向 wheel 都把解锁计时往后推；手指/惯性真正停下后 280ms 才允许下一次切换。
      if (wheelUnlockTimer) clearTimeout(wheelUnlockTimer);
      wheelUnlockTimer = setTimeout(() => {
        wheelLocked = false;
        wheelAccum = 0;
      }, WHEEL_GESTURE_IDLE_MS);

      if (wheelLocked) {
        wheelAccum = 0;
        return;
      }

      // 反方向事件意味着用户明确开了新手势，把之前同方向残留的 accum 清掉再算
      if (wheelAccum !== 0 && Math.sign(wheelAccum) !== Math.sign(e.deltaX)) {
        wheelAccum = 0;
      }

      if (!enabledRef.current) {
        wheelAccum = 0;
        return;
      }

      wheelAccum += e.deltaX;
      if (Math.abs(wheelAccum) >= WHEEL_TRIGGER_DELTA) {
        const direction: 1 | -1 = wheelAccum > 0 ? 1 : -1;
        setTab((prev) =>
          direction > 0 ? Math.min(prev + 1, max) : Math.max(prev - 1, min),
        );
        wheelLocked = true;
        wheelAccum = 0;
      }
    }

    /* 全局 touch：页面任意位置左右滑动切 tab */
    let startX = 0;
    let startY = 0;
    let isHz: boolean | null = null;
    let exempt = false;

    function onTouchStart(e: TouchEvent) {
      startX = e.touches[0]?.clientX ?? 0;
      startY = e.touches[0]?.clientY ?? 0;
      isHz = null;
      exempt = isExempt(e.target);
    }
    function onTouchMove(e: TouchEvent) {
      if (exempt || isHz === false) return;
      const dx = (e.touches[0]?.clientX ?? startX) - startX;
      const dy = (e.touches[0]?.clientY ?? startY) - startY;
      if (
        isHz === null &&
        (Math.abs(dx) > TOUCH_AXIS_LOCK_DELTA || Math.abs(dy) > TOUCH_AXIS_LOCK_DELTA)
      ) {
        isHz = Math.abs(dx) > Math.abs(dy);
      }
      if (isHz) e.preventDefault();
    }
    function onTouchEnd(e: TouchEvent) {
      if (exempt || !isHz || !enabledRef.current) return;
      const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
      if (Math.abs(dx) > TOUCH_TRIGGER_DELTA) {
        setTab((prev) =>
          dx < 0 ? Math.min(prev + 1, max) : Math.max(prev - 1, min),
        );
      }
    }

    document.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
    document.documentElement.style.overscrollBehaviorX = "none";

    return () => {
      if (wheelUnlockTimer) clearTimeout(wheelUnlockTimer);
      document.removeEventListener("wheel", onWheel);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.documentElement.style.overscrollBehaviorX = "";
    };
  }, [setTab, min, max]);
}
