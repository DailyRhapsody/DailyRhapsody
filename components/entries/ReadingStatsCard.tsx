"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ReadingCloudScreen } from "@/components/entries/ReadingCloudScreen";
import type { ReadingStats } from "@/lib/weread";

/**
 * 微信读书阅读数据卡。
 *
 * 与卡片条另外三张同尺寸（168 × 148），按数据有无轮播最多七屏：
 * 累计总览（累计时长 · 读过本数 · 阅读天数）、本月时长曲线、本月读得最多、
 * 累计阅读时段，以及三屏**书籍分布云图**（作者、阅读分类、出版社）。
 * 云图屏用的还是这一张卡，不额外占卡片条的位置；云图屏内不写字段名，只有词。
 * 某一屏没有数据就不出现，例如时段未达接口的展示阈值、或累计周期整个缺失时。
 *
 * 内边距与「博客数」卡对齐：四边都是 20px（p-5）。卡仍是 168 × 148，
 * 因此内容盒只有 126 × 106 —— 比原先的 146 × 126 少了一圈，
 * 卡内字号与行数都按这个高度重配（见下面的高度账）。
 *
 * 排版与配色刻意与「博客数」卡保持同一套：
 *   主数字 text-xl font-bold text-zinc-900 dark:text-zinc-50
 *   说明文字 text-[0.7rem] text-zinc-500 dark:text-zinc-400
 *   次级文字 text-[0.7rem] text-zinc-400 dark:text-zinc-500
 * 云图屏的词字号是唯一例外（云图靠字号表达权重），区间与依据见 ReadingCloudScreen。
 *
 * 交互：自动轮播 5s；悬停、聚焦、页面不可见、减少动态效果时暂停；左右方向键手动切屏。
 * 不放分页圆点（用户明确不要），屏序号只写进无障碍名称。不做卡内横滑切页，
 * 横向手势留给卡片条自身的滚动。
 */

const ROTATE_MS = 5000;

/**
 * 书目最多展示几条，以及何时还放得下本月摘要行。
 * 高度账按 20px 内边距后的内容盒重算（126 宽 × 106 高），不是随手定的数：
 *   行盒 20px（0.7rem 字号配 leading-5），行距 8px，摘要行连行距 28px
 *   4 行：4×20 + 3×8 = 104 ≤ 106，放得下
 *   5 行：5×20 + 4×8 = 132 > 106，放不下
 *   3 行 + 摘要：3×20 + 2×8 + 28 = 104 ≤ 106，放得下
 *   4 行 + 摘要：4×20 + 3×8 + 28 = 132 > 106，放不下
 */
const MAX_BOOK_ROWS = 4;
const MAX_BOOK_ROWS_WITH_SUMMARY = 3;

/**
 * 主轴尺寸。viewBox 与容器同比例，避免缩放导致的粗细不均。
 * 20px 内边距后内容盒是 126 宽，曲线实际拿到的高度约 50px
 * （106 - 主数字 28 - 说明 16 - 上间距 4，余下全给曲线）。
 */
const CURVE_W = 126;
const CURVE_H = 50;

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/**
 * 本月时长曲线。Catmull-Rom 转三次贝塞尔做平滑，下方铺一层同色渐变。
 * 只画已过去的天数，未来的日子不补点，避免曲线末端出现断崖。
 *
 * 上下各留 CURVE_PAD 的内缩：零点画在基线 BASE_Y 上，渐变区域也收在基线上。
 * 早先渐变一路铺到 viewBox 底边，数值区上方有内缩、下方没有，看起来贴着容器下沿。
 */
const CURVE_PAD = 3;
const CURVE_BASE_Y = CURVE_H - CURVE_PAD;
/** 折线首尾的横向内缩：圆头线帽与末端圆点都要留在容器内，否则会被裁成平口 */
const CURVE_EDGE_L = 0.75;
const CURVE_EDGE_R = 2.5;
const CURVE_X0 = CURVE_EDGE_L;
const CURVE_X1 = CURVE_W - CURVE_EDGE_R;

function ReadingCurve({ values }: { values: number[] }) {
  // 多屏同时在 DOM 中，渐变 id 必须逐个实例唯一：重复 id 会让后一个引用到前一个的定义
  const gradientId = useId().replace(/:/g, "");
  const { line, area, last } = useMemo(() => {
    const n = values.length;
    if (n === 0) return { line: "", area: "", last: null };
    // 按数据自身的 min~max 铺满高度，而不是 0~max。
    // 阅读时段这类数据的最小值常远离 0（你的 5 时低谷也有 15.8 小时），
    // 用 0 做底会让折线悬在上方、下方留出一整条空白填充带。
    // 代价是纵轴不再以 0 为基准：最低点只代表「本期最少」，不代表「没有」。
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const pt = (i: number, v: number): [number, number] => [
      n === 1 ? CURVE_W / 2 : CURVE_X0 + (i / (n - 1)) * (CURVE_X1 - CURVE_X0),
      CURVE_BASE_Y - ((v - min) / span) * (CURVE_H - CURVE_PAD * 2),
    ];
    const pts = values.map((v, i) => pt(i, v));

    if (n === 1) {
      const [x, y] = pts[0];
      return { line: `M ${x} ${y}`, area: "", last: [x, y] as [number, number] };
    }

    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    // 控制点夹在 [CURVE_PAD, CURVE_BASE_Y] 内。Catmull-Rom 会过冲：
    // 高值紧邻零值时控制点可能落到基线下，曲线便探出渐变区域、贴到容器下沿。
    // 夹住之后三次贝塞尔落在控制点的凸包内，曲线不可能越界。
    const clampY = (y: number) => Math.min(CURVE_BASE_Y, Math.max(CURVE_PAD, y));
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
    const areaD = `${d} L ${CURVE_X1} ${CURVE_BASE_Y} L ${CURVE_X0} ${CURVE_BASE_Y} Z`;
    return { line: d, area: areaD, last: pts[n - 1] as [number, number] };
  }, [values]);

  if (!line) return null;

  return (
    <svg
      viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34d399" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
        </linearGradient>
      </defs>
      {area ? <path d={area} fill={`url(#${gradientId})`} /> : null}
      <path
        d={line}
        fill="none"
        stroke="#34d399"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {last ? (
        // 末端圆点也要夹住：它的半径会让贴基线的点探出容器下沿
        <circle
          cx={last[0]}
          cy={Math.min(CURVE_BASE_Y - 2, Math.max(CURVE_PAD + 2, last[1]))}
          r="2"
          fill="#34d399"
        />
      ) : null}
    </svg>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

const VALUE = "tabular-nums text-zinc-900 dark:text-zinc-50";
const LABEL = "text-zinc-500 dark:text-zinc-400";
const MUTED = "text-zinc-400 dark:text-zinc-500";

/**
 * 累计总览（首屏）：总时长 + 读过本数 + 阅读天数，全部取自 overall 周期。
 * 三行都是「有则显示」——累计周期整个缺失时这一屏不出现（screens 里它的
 * 入选条件是 totalMinutes），单项缺失时只少那一行，不显示占位。
 */
function TotalScreen({ stats }: { stats: ReadingStats }) {
  return (
    <div className="flex h-full flex-col">
      <p className={`text-xl font-bold ${VALUE}`}>
        {formatDuration(stats.totalMinutes ?? 0)}
      </p>
      <p className={`text-[0.7rem] leading-5 ${LABEL}`}>累计阅读时长</p>
      <div className="mt-1 flex min-h-0 flex-1 flex-col justify-center gap-2">
        {typeof stats.booksRead === "number" ? (
          <p className={`text-[0.7rem] tabular-nums ${MUTED}`}>读过 {stats.booksRead} 本</p>
        ) : null}
        {typeof stats.totalDays === "number" ? (
          <p className={`text-[0.7rem] tabular-nums ${MUTED}`}>阅读 {stats.totalDays} 天</p>
        ) : null}
      </div>
    </div>
  );
}

function DurationScreen({ stats }: { stats: ReadingStats }) {
  return (
    <div className="flex h-full flex-col">
      <p className={`text-xl font-bold ${VALUE}`}>
        {formatDuration(stats.monthMinutes)}
      </p>
      <p className={`text-[0.7rem] leading-5 ${LABEL}`}>本月阅读时长</p>
      <div className="mt-1 min-h-0 flex-1">
        <ReadingCurve values={stats.daily} />
      </div>
    </div>
  );
}

function BooksScreen({ stats }: { stats: ReadingStats }) {
  // 摘要行只在还有余量时出现，书多时把高度让给书目
  const showSummary = Boolean(stats.summary) && stats.books.length <= MAX_BOOK_ROWS_WITH_SUMMARY;
  const books = stats.books.slice(0, MAX_BOOK_ROWS);
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <ul className="flex flex-col gap-2">
        {books.map((b, i) => (
          <li key={`${b.title}-${i}`} className="flex h-5 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[0.7rem] text-zinc-900 dark:text-zinc-50">
              {b.title}
            </span>
            {b.album ? (
              <span className={`shrink-0 text-[0.7rem] ${MUTED}`}>听</span>
            ) : null}
            <span className={`shrink-0 text-[0.7rem] tabular-nums ${MUTED}`}>
              {formatDuration(b.minutes)}
            </span>
          </li>
        ))}
      </ul>
      {showSummary ? (
        <p className={`text-[0.7rem] ${MUTED}`}>{stats.summary}</p>
      ) : null}
    </div>
  );
}

/** 累计阅读时段。preferTime 从 6 时起排到次日 5 时，高峰小时由数据本身算出 */
function HourlyScreen({ stats }: { stats: ReadingStats }) {
  const peakHour = (6 + stats.hourly.indexOf(Math.max(...stats.hourly))) % 24;
  return (
    <div className="flex h-full flex-col">
      <p className={`text-xl font-bold ${VALUE}`}>{peakHour} 时</p>
      <p className={`text-[0.7rem] leading-5 ${LABEL}`}>
        {stats.hourlyWord ? `${stats.hourlyWord} · 6 时起` : "阅读时段 · 6 时起"}
      </p>
      <div className="mt-1 min-h-0 flex-1">
        <ReadingCurve values={stats.hourly} />
      </div>
    </div>
  );
}

export function ReadingStatsCard({ stats }: { stats: ReadingStats | null }) {
  const screens = useMemo(() => {
    if (!stats) return [];
    // 云图屏插在统计屏之后：作者与出版社两类的词组都由接口的累计周期给出，
    // 排在一起读者才看得出「时长 → 作者 → 分类」是同一份累计数据的几种切面
    const cloudScreens = [...stats.authorClouds, ...stats.publisherClouds].map((cloud, i) => ({
      key: `cloud-${i}`,
      label: cloud.label,
      node: <ReadingCloudScreen cloud={cloud} />,
    }));
    return [
      // 累计总览放首屏：一眼能看到「总共读了多久、读过多少本」，本月曲线顺位第二。
      // 累计周期缺失时它整体不出现，首屏回落到本月时长。
      ...(stats.totalMinutes
        ? [{ key: "total", label: "累计总览", node: <TotalScreen stats={stats} /> }]
        : []),
      { key: "duration", label: "本月时长", node: <DurationScreen stats={stats} /> },
      ...(stats.books.length
        ? [{ key: "books", label: "本月读得最多", node: <BooksScreen stats={stats} /> }]
        : []),
      ...(stats.hourly.length
        ? [{ key: "hourly", label: "阅读时段", node: <HourlyScreen stats={stats} /> }]
        : []),
      ...cloudScreens,
    ];
  }, [stats]);

  const panels = screens.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced || paused || panels < 2) return;
    const id = window.setInterval(() => setIndex((s) => (s + 1) % panels), ROTATE_MS);
    return () => window.clearInterval(id);
  }, [reduced, paused, panels]);

  useEffect(() => {
    const onVis = () => setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const go = useCallback(
    (delta: number) => setIndex((s) => (s + delta + panels) % panels),
    [panels],
  );

  // 没有数据就整张卡不渲染：宁可少一张卡，也不显示空壳
  if (!stats || panels === 0) return null;

  const current = Math.min(index, panels - 1);

  return (
    <div
      ref={boxRef}
      role="group"
      aria-roledescription="轮播卡片"
      // 没有可见的分页指示，屏序号放进无障碍名称；读数屏变化时读屏能跟着播报
      aria-label={`微信读书阅读数据：${screens[current].label}，第 ${current + 1} 屏，共 ${panels} 屏`}
      tabIndex={0}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setPaused(true);
          go(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          setPaused(true);
          go(-1);
        }
      }}
      className="relative flex h-[148px] w-[168px] shrink-0 flex-col rounded-xl border border-zinc-200 bg-white/80 p-5 shadow-sm outline-none transition-apple focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800/80 dark:focus-visible:ring-zinc-500"
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {screens.map((s, i) => (
          <div
            key={s.key}
            aria-hidden={i !== current}
            className={`absolute inset-0 transition-apple ${
              i === current ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            {s.node}
          </div>
        ))}
      </div>
    </div>
  );
}
