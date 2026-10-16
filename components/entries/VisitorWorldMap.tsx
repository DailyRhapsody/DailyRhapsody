"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WORLD_LAT_BOTTOM,
  WORLD_LAT_TOP,
  WORLD_MASK_H,
  WORLD_MASK_W,
  decodeWorldMask,
  type VisitorMapPoint,
} from "@/lib/visitor-map";

/**
 * 博客文章流背后的像素世界地图 + 访客光点。
 *
 * 结构是三层，缺一层就会出现「卡片下面完全看不见地图」的观感问题：
 *   1. 地图层（静态 canvas）：陆地格按像素点画出来，只画一次，缩放/主题变化时重画；
 *   2. 光点层（动态 canvas）：每帧只 clear + 画几十个光点，不重画底图；
 *   3. 让位给页面：更上层是页面自己的半透明底色与卡片，靠它们的透明度把地图透出来。
 * 容器是指针穿透的装饰层，不参与命中测试，也不进无障碍树。
 *
 * 强度：默认为「能看见但不抢字」的弱化档（intensity = 1），预览页可以调；强到影响阅读就不是背景了。
 * 动画：光点呼吸 + 最亮三个的缓慢涟漪；prefers-reduced-motion 下全部静止，
 * 页面切到后台时停掉 rAF。
 */
export function VisitorWorldMap({
  points,
  intensity = 1,
}: {
  points: VisitorMapPoint[] | null;
  /** 底图与光点的整体强度，1 是默认的弱化档 */
  intensity?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const dotRef = useRef<HTMLCanvasElement>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef({ cell: 0, top: 0, w: 0, h: 0 });

  const landBits = useRef<Uint8Array | null>(null);

  /* 系统配色与「减弱动态效果」：只在媒体变化时更新 state，底图与光点都跟着重绘。
     之前每帧都读两次 matchMedia，运行时切主题时虽然能跟上，但代价是每帧都在做媒体查询。 */
  const [scheme, setScheme] = useState({ dark: false, reduce: false });
  useEffect(() => {
    const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
    const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setScheme({ dark: darkMq.matches, reduce: reduceMq.matches });
    sync();
    darkMq.addEventListener("change", sync);
    reduceMq.addEventListener("change", sync);
    return () => {
      darkMq.removeEventListener("change", sync);
      reduceMq.removeEventListener("change", sync);
    };
  }, []);

  /* 最亮三个光点的 key：按 points 算一次，不进 rAF 循环（否则每帧 sort 一遍） */
  const brightestKeys = useMemo(
    () =>
      new Set(
        [...(points ?? [])]
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
          .map((p) => `${p.lat},${p.lon}`),
      ),
    [points],
  );

  const decodeOnce = useCallback(() => {
    if (!landBits.current) landBits.current = decodeWorldMask();
    return landBits.current;
  }, []);

  const paintMap = useCallback(() => {
    const host = hostRef.current;
    const canvas = mapRef.current;
    if (!host || !canvas) return;
    const w = Math.round(host.clientWidth);
    const h = Math.round(host.clientHeight);
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const bits = decodeOnce();

    // 格子保持正方形：宽放得下就按宽，屏幕很宽时按高收一点，避免地图被视口上下裁断
    const cell = Math.min(w / WORLD_MASK_W, (h * 0.86) / WORLD_MASK_H);
    const top = (h - cell * WORLD_MASK_H) / 2;
    stateRef.current = { cell, top, w, h };

    for (const c of [
      canvas,
      dotRef.current,
      staticRef.current ?? (staticRef.current = document.createElement("canvas")),
    ]) {
      if (!c) continue;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const off = staticRef.current!;
    const ctx = off.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const dark = scheme.dark;
    const alpha = (dark ? 0.26 : 0.22) * intensity;
    ctx.fillStyle = dark
      ? `rgba(190,190,200,${alpha})`
      : `rgba(82,82,91,${alpha})`;
    const size = Math.max(1, cell * 0.5);
    ctx.save();
    ctx.translate(0, top);
    for (let row = 0; row < WORLD_MASK_H; row += 1) {
      for (let col = 0; col < WORLD_MASK_W; col += 1) {
        if (!bits[row * WORLD_MASK_W + col]) continue;
        ctx.fillRect(col * cell + (cell - size) / 2, row * cell + (cell - size) / 2, size, size);
      }
    }
    ctx.restore();

    const view = canvas.getContext("2d")!;
    view.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.clearRect(0, 0, w, h);
    view.drawImage(off, 0, 0, w, h);
  }, [decodeOnce, intensity, scheme.dark]);

  const paintDots = useCallback(
    (t: number) => {
      const canvas = dotRef.current;
      const host = hostRef.current;
      if (!canvas || !host) return;
      const { cell, top, w, h } = stateRef.current;
      if (!w || !h) return;
      const ctx = canvas.getContext("2d")!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!points || points.length === 0) return;

      const { dark, reduce } = scheme;
      const brightest = brightestKeys;

      for (const p of points) {
        const x = ((p.lon + 180) / 360) * WORLD_MASK_W * cell;
        const y = top + ((WORLD_LAT_TOP - p.lat) / (WORLD_LAT_TOP - WORLD_LAT_BOTTOM)) * WORLD_MASK_H * cell;
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
        const phase = ((p.lat * 7.3 + p.lon * 3.1) % 6.283) || 0;
        const pulse = reduce ? 1 : 0.88 + 0.12 * Math.sin(t / 1500 + phase);
        const weight = 1 + Math.log10(p.count + 1) * 0.85;
        const r = cell * 0.2 * weight * pulse;
        const a = intensity;

        const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.6);
        if (dark) {
          glow.addColorStop(0, `rgba(190,247,255,${0.5 * a})`);
          glow.addColorStop(0.32, `rgba(125,211,252,${0.2 * a})`);
          glow.addColorStop(1, "rgba(125,211,252,0)");
        } else {
          glow.addColorStop(0, `rgba(14,165,233,${0.34 * a})`);
          glow.addColorStop(0.32, `rgba(14,165,233,${0.14 * a})`);
          glow.addColorStop(1, "rgba(14,165,233,0)");
        }
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 3.6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = dark
          ? `rgba(232,253,255,${0.92 * a})`
          : `rgba(12,116,158,${0.85 * a})`;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.8, r * 0.5), 0, Math.PI * 2);
        ctx.fill();

        if (brightest.has(`${p.lat},${p.lon}`)) {
          const tt = reduce ? 0.4 : (t / 6000 + phase / 6.283) % 1;
          ctx.strokeStyle =
            (dark ? "rgba(190,247,255," : "rgba(14,165,233,") + ((1 - tt) * 0.26 * a).toFixed(3) + ")";
          ctx.lineWidth = Math.max(0.6, r * 0.2);
          ctx.beginPath();
          ctx.arc(x, y, r * (1.8 + tt * 5), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    },
    [brightestKeys, intensity, points, scheme],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // ResizeObserver 在 observe 时会立刻回调一次，所以这里不再单独调用 paintMap()，
    // 否则首帧会把 4344 个陆地格画两遍。
    const ro = new ResizeObserver(() => paintMap());
    ro.observe(host);
    return () => ro.disconnect();
  }, [paintMap]);

  useEffect(() => {
    if (!points || points.length === 0) {
      const canvas = dotRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        // 复位变换后按位图尺寸清：带着 dpr 缩放用 CSS 尺寸清，只会清掉 (1/dpr)^2 那一块
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      // 动效被禁用时画一帧就结束：视觉上本来就是静止的，没有理由继续 60Hz 重绘
      paintDots(0);
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const onReduceChange = () => {
        if (mq.matches) paintDots(0);
      };
      mq.addEventListener("change", onReduceChange);
      return () => mq.removeEventListener("change", onReduceChange);
    }
    let raf = 0;
    const tick = (t: number) => {
      if (!document.hidden) paintDots(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paintDots, points, scheme.reduce]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div
        className="absolute inset-0"
        style={{
          maskImage:
            "radial-gradient(132% 84% at 50% 50%, #000 58%, rgba(0,0,0,.4) 85%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(132% 84% at 50% 50%, #000 58%, rgba(0,0,0,.4) 85%, transparent 100%)",
        }}
      >
        <canvas ref={mapRef} className="absolute inset-0 h-full w-full" />
      </div>
      <canvas ref={dotRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
