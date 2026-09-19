"use client";

import { useEffect } from "react";

/* ── 连击识别 ── */
const CLICK_GAP_MS = 450; // 两次点击间隔超过它就重新计数
const CLICK_RADIUS_PX = 40; // 离上一次点击太远也重新计数
const MIN_CLICKS = 3; // 第 3 下起每点一次炸一簇

/* ── 花朵 ── */
const FLOWERS = ["🌸", "🌼", "🌺", "🌷"];
const PER_BURST = 16;
const MAX_ALIVE = 160; // 狂点时同屏最多这么多朵，超出的这一簇不放

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

function burst(layer: HTMLElement, x: number, y: number) {
  if (layer.childElementCount + PER_BURST > MAX_ALIVE) return;
  for (let i = 0; i < PER_BURST; i++) {
    const el = document.createElement("span");
    el.textContent = FLOWERS[(Math.random() * FLOWERS.length) | 0];
    const size = 14 + Math.random() * 14;
    el.style.cssText = `position:absolute;left:${x}px;top:${y}px;font-size:${size}px;line-height:1;will-change:transform,opacity`;
    layer.appendChild(el);

    // 均匀分布在一圈上再加点抖动，飞出去后受重力下落、旋转、淡出
    const angle = (i / PER_BURST) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const dist = 70 + Math.random() * 90;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const spin = (Math.random() - 0.5) * 540;
    const fall = 50 + Math.random() * 60;
    const duration = 900 + Math.random() * 500;
    const anim = el.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.2) rotate(0deg)", opacity: 1 },
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin * 0.6}deg)`,
          opacity: 1,
          offset: 0.45,
        },
        {
          transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy * 1.15 + fall}px)) scale(0.85) rotate(${spin}deg)`,
          opacity: 0,
        },
      ],
      { duration, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" }
    );
    anim.onfinish = () => el.remove();
    anim.oncancel = () => el.remove();
  }
}

/**
 * 彩蛋：在空白处快速连点（同一位置 450ms 内），第 3 下起每点一次，花朵从点击处炸开。
 * 系统开了「减少动态效果」时不放。
 */
export default function FlowerBurst() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const layer = document.createElement("div");
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden";
    document.body.appendChild(layer);

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
      if (count >= MIN_CLICKS) burst(layer, e.clientX, e.clientY);
    };

    addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      removeEventListener("pointerdown", onPointerDown);
      layer.remove();
    };
  }, []);

  return null;
}
