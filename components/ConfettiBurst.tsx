"use client";

import { useEffect } from "react";
import type { CreateTypes, Options } from "canvas-confetti";

/* ── 连击识别 ── */
const CLICK_GAP_MS = 450; // 两次点击间隔超过它就重新计数
const CLICK_RADIUS_PX = 40; // 离上一次点击太远也重新计数
const MIN_CLICKS = 3; // 第 3 下起每点一次炸一小团

/**
 * 礼花参数：鼠标附近一小团彩纸，像微信 🎉、iMessage 的彩纸，而不是满屏撒。
 * 初速按 startVelocity 的 0.5～1.5 倍随机、每帧乘 decay 衰减，飞出约 60～180px 后受重力飘落
 */
const BURST: Options = {
  particleCount: 40,
  spread: 360,
  startVelocity: 14,
  decay: 0.88,
  gravity: 0.7,
  ticks: 90,
  scalar: 1,
  shapes: ["square", "circle"],
  colors: ["#ff4d6d", "#ffb703", "#4cc9f0", "#7b2cbf", "#06d6a0", "#f72585", "#3a86ff"],
  disableForReducedMotion: true,
};

/** 这些元素上的点击不算「空白处」：可交互的控件、图片、流程图、弹层 */
const NOT_BLANK =
  "a, button, input, textarea, select, label, summary, img, video, svg, canvas, form, [role='button'], [role='dialog'], [contenteditable='true'], [data-scroll-timeline]";

/** 点击是否落在字上：只量目标元素自己的文字节点，行间空隙、行尾空白都算空白处 */
function hitsText(el: Element, x: number, y: number): boolean {
  const range = document.createRange();
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
  }
  return false;
}

function isBlank(target: EventTarget | null, x: number, y: number): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(NOT_BLANK)) return false;
  return !hitsText(target, x, y);
}

/**
 * 彩蛋：在空白处快速连点（同一位置 450ms 内），第 3 下起每点一次，从点击处炸开一小团彩纸。
 * 用 canvas-confetti（ISC 协议）绘制；系统开了「减少动态效果」时不放。
 */
export default function ConfettiBurst() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
    document.body.appendChild(canvas);

    let fire: CreateTypes | null = null;
    let disposed = false;
    // 用到时才加载（约 6KB），不进首屏
    const ready = import("canvas-confetti").then(({ default: confetti }) => {
      if (disposed) return;
      fire = confetti.create(canvas, { resize: true, useWorker: false });
    });

    let count = 0;
    let lastT = 0;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !isBlank(e.target, e.clientX, e.clientY)) {
        count = 0;
        return;
      }
      const near = Math.hypot(e.clientX - lastX, e.clientY - lastY) <= CLICK_RADIUS_PX;
      count = e.timeStamp - lastT <= CLICK_GAP_MS && near ? count + 1 : 1;
      lastT = e.timeStamp;
      lastX = e.clientX;
      lastY = e.clientY;
      if (count < MIN_CLICKS) return;
      const origin = { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
      void ready.then(() => fire?.({ ...BURST, origin }));
    };

    addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      disposed = true;
      removeEventListener("pointerdown", onPointerDown);
      fire?.reset();
      canvas.remove();
    };
  }, []);

  return null;
}
