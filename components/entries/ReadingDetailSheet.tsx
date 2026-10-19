"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ReadingAuthor,
  ReadingBook,
  ReadingCategory,
  ReadingCounter,
  ReadingMedal,
  ReadingPreferBook,
  ReadingPublisher,
  ReadingStats,
} from "@/lib/weread";

/**
 * 微信读书阅读数据详情层。
 *
 * 卡片只有 168 × 148，轮播屏能放下的信息量有限；详情层把接口
 * （/readdata/detail，monthly + overall 两个周期）能给出的阅读数据全部展开：
 *
 * 本月：总时长、有效阅读天数、自然日均、与上期日均对比、readStat 四项
 * （读过／读完／阅读／笔记）、逐日时长、书目排行、偏好分类。
 * 累计：总时长、阅读天数、阅读日均、注册至今天数、readStat 四项、
 * 文字与听书构成、年度时长、书目排行、阅读时段、偏好分类／作者／出版社、
 * 偏好书籍卡、勋章。
 *
 * 接口里另有一批纯技术字段（book.payType、maxFreeChapter、blockSaveImg 等）
 * 与好友排行 rank：前者不是阅读信息，后者涉及他人，均不展示。
 *
 * 交互约定：
 * - 全屏层：整屏不透明覆盖（与思维大树覆盖层同一形态），内容列限宽 960px 保证行宽；
 *   用 portal 挂到 body，避免 /blog 内容树的 3D transform 让 fixed 退化。
 * - 内部纵向滚动；Esc 或右上角关闭按钮退出，无遮罩点击区。
 * - 左右方向键在本月／累计两个视图间切换，与卡片上左右键切屏的习惯一致。
 * - 根节点带 data-hscroll：整页的横滑切 tab 手势会豁免该子树，
 *   否则层内横向滚动或触屏左右滑动会被 hook preventDefault 并切走 tab。
 * - 打开时锁 body 滚动、把焦点移进面板；关闭由调用方还原焦点。
 */

function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return `${h}h ${rest}m`;
  if (h) return `${h}h`;
  return `${rest}m`;
}

/** 秒时间戳 → YYYY-MM-DD。详情层只在客户端挂载，不存在水合差异 */
function formatDate(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 「2026-10」→「2026 年 10 月」 */
function formatMonth(month: string): string {
  const [y, m] = month.split("-");
  if (!y || !m) return month;
  return `${y} 年 ${Number(m)} 月`;
}

function share(part: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((part / total) * 100));
}

function daysSince(seconds?: number): number | undefined {
  if (!seconds || !Number.isFinite(seconds)) return undefined;
  const diff = Date.now() - seconds * 1000;
  if (diff < 0) return undefined;
  return Math.floor(diff / 86_400_000) + 1;
}

/** 一个分区。标题同层对称、说明右对齐，整层共用这一套排版 */
function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 first:mt-0">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[0.8rem] font-semibold tracking-wide text-zinc-900 dark:text-zinc-100">
          {title}
        </h3>
        {note ? (
          <span className="shrink-0 text-[0.66rem] text-zinc-400 dark:text-zinc-500">{note}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white px-3 py-2.5 dark:border-zinc-700/80 dark:bg-zinc-800/50">
      <p className="text-[0.68rem] text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-[1.05rem] font-semibold tabular-nums leading-5 text-zinc-900 dark:text-zinc-50">
        {value}
      </p>
      {sub ? (
        <p className="mt-1 text-[0.66rem] leading-4 text-zinc-400 dark:text-zinc-500">{sub}</p>
      ) : null}
    </div>
  );
}

/** readStat 四项。原文计数直接展示，接口给「1.7万条」就写「1.7万条」 */
function CounterRow({ counters }: { counters: ReadingCounter[] }) {
  if (counters.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {counters.map((c) => (
        <li
          key={c.label}
          className="rounded-xl border border-zinc-200/80 bg-white px-3 py-2.5 dark:border-zinc-700/80 dark:bg-zinc-800/50"
        >
          <p className="text-[0.66rem] text-zinc-500 dark:text-zinc-400">{c.label}</p>
          <p className="mt-1 text-[0.95rem] font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {c.value}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * 逐日柱图。柱高按本月最大值归一，零值日留 2px 占位以免横轴看起来断开。
 * 峰值日加亮并在图下标出具体日期与时长。
 */
function DailyBars({ values }: { values: number[] }) {
  const peak = useMemo(() => {
    let index = -1;
    let max = 0;
    values.forEach((v, i) => {
      if (v > max) {
        max = v;
        index = i;
      }
    });
    return { index, max };
  }, [values]);

  if (values.length === 0) return null;
  const max = peak.max > 0 ? peak.max : 1;

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-3 dark:border-zinc-700/80 dark:bg-zinc-800/50">
      <div className="flex h-28 items-end gap-[3px]">
        {values.map((v, i) => {
          const height = v > 0 ? Math.max(3, (v / max) * 100) : 2;
          return (
            <div
              key={i}
              title={`${i + 1} 日 · ${formatDuration(v)}`}
              className={`flex-1 rounded-t-[2px] ${
                i === peak.index && peak.max > 0
                  ? "bg-emerald-400 dark:bg-emerald-400"
                  : "bg-emerald-300/45 dark:bg-emerald-400/30"
              }`}
              style={{ height: `${height}%` }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[0.64rem] text-zinc-400 dark:text-zinc-500">
        <span>1 日</span>
        <span>{values.length} 日</span>
      </div>
      {peak.max > 0 ? (
        <p className="mt-1.5 text-[0.7rem] text-zinc-500 dark:text-zinc-400">
          峰值 {peak.index + 1} 日 ·{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {formatDuration(peak.max)}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * 年度柱图。接口 readTimes 在 overall 周期按年分桶。
 * 柱顶不写时长：9 年并排时移动端每列只有 34px 宽，`124h 3m` 这类文本会互相压住；
 * 峰值单独在图下标出，逐年数值走 title。
 */
function YearBars({ years }: { years: { year: number; minutes: number }[] }) {
  const peak = useMemo(() => {
    let best = years[0];
    for (const y of years) if (y.minutes > (best?.minutes ?? 0)) best = y;
    return best;
  }, [years]);
  const max = Math.max(...years.map((y) => y.minutes), 1);
  if (years.length === 0) return null;
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-3 dark:border-zinc-700/80 dark:bg-zinc-800/50">
      <div className="flex h-28 items-end gap-1.5">
        {years.map((y) => (
          <div key={y.year} className="flex h-full min-w-0 flex-1 items-end">
            <div
              className="w-full rounded-t-[3px] bg-emerald-300/60 dark:bg-emerald-400/40"
              style={{ height: `${Math.max(3, (y.minutes / max) * 100)}%` }}
              title={`${y.year} 年 · ${formatDuration(y.minutes)}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {years.map((y) => (
          <span
            key={y.year}
            className="min-w-0 flex-1 text-center text-[0.64rem] tabular-nums text-zinc-400 dark:text-zinc-500"
          >
            {y.year}
          </span>
        ))}
      </div>
      {peak ? (
        <p className="mt-1.5 text-[0.7rem] text-zinc-500 dark:text-zinc-400">
          峰值 {peak.year} 年 ·{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {formatDuration(peak.minutes)}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * 阅读时段。接口 preferTime 是 24 个秒数，从 6 时起排到次日 5 时；
 * 图上仍按真实钟点标注，避免读者把第一根柱当成 0 时。
 */
function HourBars({ hourly, word }: { hourly: number[]; word: string }) {
  const peak = useMemo(() => {
    let index = -1;
    let max = 0;
    hourly.forEach((v, i) => {
      if (v > max) {
        max = v;
        index = i;
      }
    });
    return { index, max };
  }, [hourly]);

  if (hourly.length === 0) return null;
  const max = peak.max > 0 ? peak.max : 1;
  const peakHour = peak.index >= 0 ? (6 + peak.index) % 24 : undefined;

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-3 dark:border-zinc-700/80 dark:bg-zinc-800/50">
      <div className="flex h-24 items-end gap-[2px]">
        {hourly.map((v, i) => (
          <div
            key={i}
            title={`${(6 + i) % 24} 时 · ${formatDuration(Math.round(v / 60))}`}
            className={`flex-1 rounded-t-[2px] ${
              i === peak.index && peak.max > 0
                ? "bg-emerald-400"
                : "bg-emerald-300/45 dark:bg-emerald-400/30"
            }`}
            style={{ height: `${v > 0 ? Math.max(3, (v / max) * 100) : 2}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[0.62rem] tabular-nums text-zinc-400 dark:text-zinc-500">
        <span>6 时</span>
        <span>12 时</span>
        <span>18 时</span>
        <span>0 时</span>
        <span>5 时</span>
      </div>
      {peakHour !== undefined ? (
        <p className="mt-1.5 text-[0.7rem] text-zinc-500 dark:text-zinc-400">
          高峰 {peakHour} 时
          {word ? ` · ${word}` : ""}
        </p>
      ) : null}
    </div>
  );
}

/** 文字阅读／听书构成。两段都标出时长与占比，不只给一个百分比 */
function SplitBar({
  split,
}: {
  split: { readMinutes: number; listenMinutes: number; readRate: number };
}) {
  const total = split.readMinutes + split.listenMinutes;
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-3 dark:border-zinc-700/80 dark:bg-zinc-800/50">
      <div className="flex items-baseline justify-between text-[0.72rem] text-zinc-600 dark:text-zinc-300">
        <span>
          文字阅读 <span className="font-semibold tabular-nums">{formatDuration(split.readMinutes)}</span>{" "}
          · {split.readRate}%
        </span>
        <span>
          听书{" "}
          <span className="font-semibold tabular-nums">{formatDuration(split.listenMinutes)}</span> ·{" "}
          {100 - split.readRate}%
        </span>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-700">
        <div
          className="h-full bg-emerald-400"
          style={{ width: `${share(split.readMinutes, total) || split.readRate}%` }}
        />
      </div>
    </div>
  );
}

/** 无封面或封面加载失败时的占位：书名首字 + 中性底 */
function CoverPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-16 w-11 shrink-0 items-center justify-center rounded-[4px] bg-zinc-100 text-[0.8rem] font-medium text-zinc-400 dark:bg-zinc-700/60 dark:text-zinc-500">
      {title.slice(0, 1)}
    </div>
  );
}

function BookCover({ book }: { book: ReadingBook }) {
  const [failed, setFailed] = useState(false);
  if (!book.cover || failed) return <CoverPlaceholder title={book.title} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 微信读书封面走外部 CDN，尺寸固定，无需图片优化器
    <img
      src={book.cover}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-16 w-11 shrink-0 rounded-[4px] object-cover ring-1 ring-zinc-200/70 dark:ring-zinc-700"
    />
  );
}

/**
 * 书目排行。占比以该周期总时长为分母（接口的 readTime 是秒转分钟），
 * 条末给百分比，读者能直接看出集中度。
 */
function BookList({ books, totalMinutes }: { books: ReadingBook[]; totalMinutes: number }) {
  if (books.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-200 px-3 py-4 text-[0.72rem] text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
        本周期没有达到接口展示阈值的书目（单本需满 5 分钟）。
      </p>
    );
  }
  return (
    <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:divide-zinc-800 dark:border-zinc-700/80 dark:bg-zinc-800/50">
      {books.map((b, i) => {
        const pct = share(b.minutes, totalMinutes);
        const title = b.link ? (
          <a
            href={b.link}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate transition-colors hover:text-emerald-600 dark:hover:text-emerald-400"
          >
            {b.title}
          </a>
        ) : (
          <span className="truncate">{b.title}</span>
        );
        return (
          <li key={`${b.title}-${i}`} className="flex items-center gap-3 px-3 py-2.5">
            <BookCover book={b} />
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-baseline gap-1.5 text-[0.78rem] font-medium text-zinc-900 dark:text-zinc-50">
                {title}
                {b.album ? (
                  <span className="shrink-0 text-[0.62rem] font-normal text-zinc-400">听书</span>
                ) : null}
              </p>
              <p className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[0.66rem] text-zinc-500 dark:text-zinc-400">
                <span className="truncate">{b.author ?? "作者未提供"}</span>
                {b.tags?.map((t) => (
                  <span
                    key={t}
                    className="shrink-0 rounded bg-zinc-100 px-1 py-px text-[0.6rem] text-zinc-500 dark:bg-zinc-700/70 dark:text-zinc-300"
                  >
                    {t}
                  </span>
                ))}
              </p>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-700/60">
                <div className="h-full rounded-full bg-emerald-300" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[0.72rem] font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                {formatDuration(b.minutes)}
              </p>
              <p className="text-[0.62rem] tabular-nums text-zinc-400 dark:text-zinc-500">{pct}%</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** 排行行（分类／作者／出版社共用）。分母取本组最大值，条长只表示组内相对量 */
function RankRows({
  rows,
}: {
  rows: { label: string; sub?: string; value: number; right: string }[];
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={`${r.label}-${i}`}>
          <div className="flex items-baseline justify-between gap-3 text-[0.72rem]">
            <p className="min-w-0 truncate text-zinc-800 dark:text-zinc-200">
              {r.label}
              {r.sub ? (
                <span className="ml-1.5 text-[0.64rem] text-zinc-400 dark:text-zinc-500">
                  {r.sub}
                </span>
              ) : null}
            </p>
            <p className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{r.right}</p>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-700/60">
            <div
              className="h-full rounded-full bg-emerald-300/80 dark:bg-emerald-400/50"
              style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CategoryRows({ categories }: { categories: ReadingCategory[] }) {
  return (
    <RankRows
      rows={categories.map((c) => ({
        label: c.name,
        sub: c.parent ? `属于${c.parent}` : undefined,
        value: c.minutes,
        right: `${formatDuration(c.minutes)}${c.books ? ` · ${c.books} 本` : ""}`,
      }))}
    />
  );
}

function AuthorRows({ authors }: { authors: ReadingAuthor[] }) {
  return (
    <RankRows
      rows={authors.map((a) => ({
        label: a.name,
        sub: a.books ? `${a.books} 本` : undefined,
        value: a.minutes,
        right: formatDuration(a.minutes),
      }))}
    />
  );
}

function PublisherRows({ publishers }: { publishers: ReadingPublisher[] }) {
  return (
    <RankRows
      rows={publishers.map((p) => ({
        label: p.name,
        value: p.books,
        right: `${p.books} 本`,
      }))}
    />
  );
}

/** 偏好书籍卡：label（我的最爱／近期偏爱…）+ 接口给的 reason */
function PreferBookGrid({ books }: { books: ReadingPreferBook[] }) {
  if (books.length === 0) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {books.map((b, i) => (
        <li
          key={`${b.label}-${i}`}
          className="flex items-start gap-2.5 rounded-xl border border-zinc-200/80 bg-white p-2.5 dark:border-zinc-700/80 dark:bg-zinc-800/50"
        >
          <BookCover book={{ title: b.title ?? b.label, minutes: 0, cover: b.cover }} />
          <div className="min-w-0 flex-1">
            <p className="text-[0.62rem] font-medium text-emerald-600 dark:text-emerald-400">
              {b.label}
            </p>
            <p className="mt-0.5 truncate text-[0.75rem] font-medium text-zinc-900 dark:text-zinc-50">
              {b.link ? (
                <a href={b.link} target="_blank" rel="noopener noreferrer" className="hover:underline">
                  {b.title}
                </a>
              ) : (
                b.title
              )}
            </p>
            {b.author ? (
              <p className="truncate text-[0.64rem] text-zinc-500 dark:text-zinc-400">{b.author}</p>
            ) : null}
            {b.reason ? (
              <p className="mt-0.5 text-[0.64rem] leading-4 text-zinc-400 dark:text-zinc-500">
                {b.reason}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 勋章墙。接口只给文案、获得日期与排名，没有图标资源 */
function MedalGrid({ medals }: { medals: ReadingMedal[] }) {
  if (medals.length === 0) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {medals.map((m, i) => (
        <li
          key={`${m.text}-${i}`}
          className="flex items-start gap-2 rounded-xl border border-zinc-200/80 bg-white px-2.5 py-2 dark:border-zinc-700/80 dark:bg-zinc-800/50"
        >
          <span
            aria-hidden
            className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-400 dark:bg-emerald-400"
          />
          <div className="min-w-0">
            <p className="text-[0.72rem] font-medium text-zinc-900 dark:text-zinc-50">{m.text}</p>
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-[0.62rem] text-zinc-400 dark:text-zinc-500">
              {m.date ? <span>{m.date} 获得</span> : null}
              {m.rankText ? <span className="truncate">{m.rankText}</span> : null}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

const VIEWS = [
  { key: "month", label: "本月" },
  { key: "total", label: "累计" },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

export function ReadingDetailSheet({
  stats,
  onClose,
}: {
  stats: ReadingStats;
  onClose: () => void;
}) {
  const [view, setView] = useState<ViewKey>("month");
  const panelRef = useRef<HTMLDivElement>(null);

  /** 打开时锁滚动并把焦点移入面板；关闭时还原，调用方负责把焦点还给卡片 */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  /** 左右键切视图、Esc 关闭、Tab 锁在面板内。挂在 window 上，焦点落到面板外时仍然有效 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setView("total");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setView("month");
      } else if (e.key === "Tab") {
        // aria-modal 只表达「背后不可交互」，浏览器不会替我们拦住 Tab；
        // 这里把焦点循环限制在面板内，避免 Tab 走到背后的页面。
        const panel = panelRef.current;
        if (!panel) return;
        const nodes = Array.from(
          panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
        ).filter((el) => el.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (active === first || active === panel)) {
          e.preventDefault();
          last.focus();
        } else if (active && !panel.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const switchView = useCallback((next: ViewKey) => setView(next), []);

  const registeredDays = daysSince(stats.registeredAt);
  const monthAverage = stats.monthAverageMinutes;
  const totalAverage =
    stats.totalDays && stats.totalMinutes
      ? Math.round(stats.totalMinutes / stats.totalDays)
      : undefined;

  /*
   * 用 portal 挂到 body：/blog 的内容树在 .entries-flip-panel 里带 3D transform，
   * 其中 position: fixed 会退化成相对该祖先定位 —— 全屏层只能盖住内容列，白底也会
   * 透出背后的头图与地图。挂到 body 后 fixed 才真正相对视口，整屏不透明。
   */
  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex flex-col bg-white dark:bg-zinc-950"
      data-hscroll
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="weread-detail-title"
        tabIndex={-1}
        className="flex h-dvh w-full flex-col overflow-hidden outline-none"
      >
        {/* 全屏层：标题与关闭固定在顶部，内容在下方滚动；内容列限宽保证阅读行宽 */}
        <header className="shrink-0 border-b border-zinc-100 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto w-full max-w-[960px] px-4 sm:px-8">
          <div className="flex items-start justify-between gap-3 pt-3 sm:pt-5">
            <div className="min-w-0">
              <h2
                id="weread-detail-title"
                className="truncate text-[0.95rem] font-semibold text-zinc-900 dark:text-zinc-50"
              >
                微信读书 · 阅读数据
              </h2>
              <p className="mt-0.5 text-[0.66rem] text-zinc-400 dark:text-zinc-500">
                {formatMonth(stats.month)}
                {stats.refreshedAt ? ` · 数据更新于 ${formatDate(stats.refreshedAt / 1000)}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div role="tablist" aria-label="统计周期" className="mt-2.5 flex gap-1 pb-2.5 sm:pb-3">
            {VIEWS.map((v) => {
              const active = v.key === view;
              return (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`weread-panel-${v.key}`}
                  id={`weread-tab-${v.key}`}
                  onClick={() => switchView(v.key)}
                  className={`rounded-full px-3 py-1 text-[0.72rem] transition-colors ${
                    active
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }`}
                >
                  {v.label}
                </button>
              );
            })}
            <span className="ml-auto hidden self-center text-[0.62rem] text-zinc-400 sm:inline dark:text-zinc-500">
              ← → 切换
            </span>
          </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-[960px] px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 sm:px-8 sm:pt-6">
          {view === "month" ? (
            <div
              role="tabpanel"
              id="weread-panel-month"
              aria-labelledby="weread-tab-month"
              className="pb-2"
            >
              <div className="rounded-xl border border-zinc-200/80 bg-white p-3.5 dark:border-zinc-700/80 dark:bg-zinc-800/50">
                <p className="text-[0.66rem] text-zinc-500 dark:text-zinc-400">本月阅读时长</p>
                <p className="mt-1 text-3xl font-bold tabular-nums leading-9 text-zinc-900 dark:text-zinc-50">
                  {formatDuration(stats.monthMinutes)}
                </p>
                <p className="mt-1.5 text-[0.68rem] text-zinc-400 dark:text-zinc-500">
                  {stats.monthStat.find((x) => x.label === "阅读")?.value ?? `${stats.monthDays} 天`}
                  {typeof stats.monthCompare === "number"
                    ? ` · 较上期日均${stats.monthCompare >= 0 ? "增长" : "下降"} ${Math.abs(
                        Math.round(stats.monthCompare * 1000) / 10,
                      )}%`
                    : ""}
                </p>
              </div>

              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <StatTile
                  label="自然日均"
                  value={monthAverage ? formatDuration(monthAverage) : "—"}
                  sub="分母为本月已过自然日"
                />
                <StatTile
                  label="有效阅读天数"
                  value={`${stats.monthDays} 天`}
                  sub="单日满 1 分钟计"
                />
              </div>

              <Section title="本月统计" note="接口 readStat">
                <CounterRow counters={stats.monthStat} />
              </Section>

              <Section title="逐日阅读时长" note={`1 至 ${stats.daily.length} 日`}>
                <DailyBars values={stats.daily} />
              </Section>

              <Section title="本月书目排行" note={`${stats.books.length} 本 · 满 5 分钟入榜`}>
                <BookList books={stats.books} totalMinutes={stats.monthMinutes} />
              </Section>

              {stats.monthCategories.length > 0 ? (
                <Section title="本月分类分布" note={stats.monthCategoryWord}>
                  <CategoryRows categories={stats.monthCategories} />
                </Section>
              ) : null}
            </div>
          ) : (
            <div
              role="tabpanel"
              id="weread-panel-total"
              aria-labelledby="weread-tab-total"
              className="pb-2"
            >
              <div className="rounded-xl border border-zinc-200/80 bg-white p-3.5 dark:border-zinc-700/80 dark:bg-zinc-800/50">
                <p className="text-[0.66rem] text-zinc-500 dark:text-zinc-400">累计阅读时长</p>
                <p className="mt-1 text-3xl font-bold tabular-nums leading-9 text-zinc-900 dark:text-zinc-50">
                  {formatDuration(stats.totalMinutes ?? 0)}
                </p>
                <p className="mt-1.5 text-[0.68rem] text-zinc-400 dark:text-zinc-500">
                  {stats.totalDays ? `阅读 ${stats.totalDays} 天` : "有效阅读天数未返回"}
                  {stats.registeredAt ? ` · ${formatDate(stats.registeredAt)} 起` : ""}
                </p>
              </div>

              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <StatTile
                  label="阅读日均"
                  value={totalAverage ? formatDuration(totalAverage) : "—"}
                  sub="累计时长 ÷ 有效阅读天数"
                />
                <StatTile
                  label="注册至今"
                  value={registeredDays ? `${registeredDays} 天` : "—"}
                  sub={stats.registeredAt ? `${formatDate(stats.registeredAt)} 起` : undefined}
                />
              </div>

              <Section title="累计统计" note="接口 readStat">
                <CounterRow counters={stats.totalStat} />
              </Section>

              {stats.split ? (
                <Section title="文字阅读与听书" note={`文字 ${stats.split.readRate}%`}>
                  <SplitBar split={stats.split} />
                </Section>
              ) : null}

              {stats.years.length > 0 ? (
                <Section
                  title="年度阅读时长"
                  note={`${stats.years[0].year}–${stats.years[stats.years.length - 1].year}`}
                >
                  <YearBars years={stats.years} />
                </Section>
              ) : null}

              <Section title="累计书目排行" note={`${stats.totalBooks.length} 本`}>
                <BookList books={stats.totalBooks} totalMinutes={stats.totalMinutes ?? 0} />
              </Section>

              {stats.hourly.length > 0 ? (
                <Section title="阅读时段" note="6 时起 · 24 小时">
                  <HourBars hourly={stats.hourly} word={stats.hourlyWord} />
                </Section>
              ) : null}

              {stats.totalCategories.length > 0 ? (
                <Section title="分类分布" note={stats.totalCategoryWord}>
                  <CategoryRows categories={stats.totalCategories} />
                </Section>
              ) : null}

              {stats.authors.length > 0 ? (
                <Section
                  title="偏好作者"
                  note={stats.authorCount ? `共 ${stats.authorCount} 位 · 前 ${stats.authors.length}` : undefined}
                >
                  <AuthorRows authors={stats.authors} />
                </Section>
              ) : null}

              {stats.publishers.length > 0 ? (
                <Section title="偏好出版社" note={`${stats.publishers.length} 家`}>
                  <PublisherRows publishers={stats.publishers} />
                </Section>
              ) : null}

              {stats.preferBooks.length > 0 ? (
                <Section title="偏好书籍" note={`${stats.preferBooks.length} 类`}>
                  <PreferBookGrid books={stats.preferBooks} />
                </Section>
              ) : null}

              {stats.medals.length > 0 ? (
                <Section title="勋章" note={`共 ${stats.medals.length} 枚`}>
                  <MedalGrid medals={stats.medals} />
                </Section>
              ) : null}
            </div>
          )}

          <p className="mt-8 border-t border-zinc-100 pt-3 text-[0.62rem] leading-5 text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
            数据来自微信读书 /readdata/detail（monthly、overall），由服务端每日拉取并缓存，浏览器不直接调用接口。
            时长按「小时／分钟」展示；书目排行只含单本满 5 分钟的条目；有效阅读天数按单日满 1 分钟计。
          </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
