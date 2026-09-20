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

/** AI 分身对话里只排除控件：面板本身是 role=dialog，按上面的名单会把整块对话都算成非空白 */
const NOT_BLANK_IN_CHAT = "a, button, input, textarea, select, img, svg, [contenteditable='true']";

function isBlank(target: EventTarget | null, x: number, y: number): boolean {
  if (!(target instanceof Element)) return false;
  const inChat = target.closest("[data-pet-chat]");
  if (target.closest(inChat ? NOT_BLANK_IN_CHAT : NOT_BLANK)) return false;
  return !hitsText(target, x, y);
}

/** 点在滚动条上（页面的或元素自己的）不算点击空白处 */
function onScrollbar(e: MouseEvent): boolean {
  const root = document.documentElement;
  if (e.clientX >= root.clientWidth || e.clientY >= root.clientHeight) return true;
  const t = e.target;
  return t instanceof Element && t.clientWidth > 0 && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight);
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

    // 画布尺寸自己维护：库只在第一次放时量一次，之后转屏、缩放窗口会被拉伸；
    // 位图按像素密度放大（最多 2 倍），Retina 屏上彩纸不发虚
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    };
    resize();
    addEventListener("resize", resize);

    let fire: CreateTypes | null = null;
    let disposed = false;
    // 页面挂上后在后台加载（约 6KB），加载失败就不放彩纸
    const ready = import("canvas-confetti")
      .then(({ default: confetti }) => {
        if (disposed) return;
        fire = confetti.create(canvas, { resize: false, useWorker: false });
      })
      .catch(() => {});

    let count = 0;
    let lastT = 0;
    let lastX = 0;
    let lastY = 0;

    // 用 click 计数：触屏上滑动、拖动页面不产生 click，不会被当成连点
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || onScrollbar(e) || !isBlank(e.target, e.clientX, e.clientY)) {
        count = 0;
        return;
      }
      const near = Math.hypot(e.clientX - lastX, e.clientY - lastY) <= CLICK_RADIUS_PX;
      count = e.timeStamp - lastT <= CLICK_GAP_MS && near ? count + 1 : 1;
      lastT = e.timeStamp;
      lastX = e.clientX;
      lastY = e.clientY;
      if (count < MIN_CLICKS) return;
      // 按画布自身的位置换算，不受滚动条宽度影响
      const r = canvas.getBoundingClientRect();
      const origin = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      void ready.then(() =>
        fire?.({
          ...BURST,
          origin,
          // 位图放大了 dpr 倍，尺寸、速度、重力同比放大，屏幕上看起来一样
          scalar: (BURST.scalar ?? 1) * dpr,
          startVelocity: (BURST.startVelocity ?? 14) * dpr,
          gravity: (BURST.gravity ?? 1) * dpr,
        })
      );
    };

    addEventListener("click", onClick, { passive: true });
    return () => {
      disposed = true;
      removeEventListener("click", onClick);
      removeEventListener("resize", resize);
      fire?.reset();
      canvas.remove();
    };
  }, []);

  return null;
}
