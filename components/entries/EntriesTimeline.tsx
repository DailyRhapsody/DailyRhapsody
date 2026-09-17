"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { formatDate12h } from "@/lib/format";
import type { Diary, EntryOutlineItem } from "./types";

/** 每篇一行，行高 8px；跨年、置顶组之后多留 8px */
const ROW_H = 8;
/** 横线宽度：10 字及以下最短 6px，3000 字及以上最长 28px，中间按对数映射 */
const MIN_W = 6;
const MAX_W = 28;
const LO = 10;
const HI = 3000;
/** 阅读线 = 文章的 scroll-margin-top（EntryCard 的 scroll-mt-24）+ 16px，两处相互依赖 */
const READING_SLACK = 16;
/** 距离超过 3 屏时先瞬移到目标前一屏，再平滑滚完最后一屏 */
const FAR_SCREENS = 3;
/** 在轨道上滚轮后 1.5s 内，不自动把轨道滚回当前篇 */
const FOLLOW_IDLE_MS = 1500;
/** 等待补载期间，页面被用户滚动超过这个距离就取消跳转 */
const CANCEL_SCROLL_PX = 120;
/** 顶栏回顶动画最长约 1.8s，超过这个时间不再等它 */
const HEADER_WAIT_MS = 2500;
const JUMP_TIMEOUT_MS = 20000;
const FAIL_SHOW_MS = 2500;
const WIDE_POINTER_QUERY = "(min-width: 1080px) and (hover: hover) and (pointer: fine)";

function lineWidth(words: number) {
  const t = (Math.log1p(words) - Math.log(LO + 1)) / (Math.log(HI + 1) - Math.log(LO + 1));
  return Math.round(MIN_W + (MAX_W - MIN_W) * Math.min(1, Math.max(0, t)));
}

function subscribeWidePointer(onChange: () => void) {
  const mql = window.matchMedia(WIDE_POINTER_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const insideTimeline = (target: EventTarget | null) =>
  target instanceof Element && target.closest("[data-entries-timeline]") != null;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 把文章顶部滚到它的 scroll-margin-top 处。
 * 不用原生 smooth scrollIntoView：从页顶出发时顶栏收起会让落点偏到视口上方。
 * 每帧按目标的实时位置插值，结束后再校正几帧；用户在页面上滚轮/触摸/按键/点击即中止。
 * 返回中止函数；onDone(completed) 在结束或中止时调用一次。
 */
function scrollToEntry(el: HTMLElement, onDone: (completed: boolean) => void): () => void {
  const root = document.documentElement;
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 96;
  const target = () =>
    Math.max(
      0,
      Math.min(root.scrollHeight - window.innerHeight, window.scrollY + el.getBoundingClientRect().top - margin),
    );
  const reduce = prefersReducedMotion();
  const prevAnchor = root.style.overflowAnchor;
  let raf = 0;
  let stopped = false;

  const stop = (completed = false) => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    // 只撤销自己设的 none；若期间别处（如顶栏回顶）已经改回，不再覆盖
    if (root.style.overflowAnchor === "none") root.style.overflowAnchor = prevAnchor === "none" ? "" : prevAnchor;
    window.removeEventListener("wheel", onUserInput, true);
    window.removeEventListener("touchstart", onUserInput, true);
    window.removeEventListener("keydown", onUserInput, true);
    window.removeEventListener("pointerdown", onUserInput, true);
    onDone(completed);
  };
  function onUserInput(e: Event) {
    // 轨道上的滚轮/点击/方向键是在浏览时间轴，不打断页面滚动（点另一条会由新的跳转接管）
    if (insideTimeline(e.target)) return;
    stop();
  }
  window.addEventListener("wheel", onUserInput, { capture: true, passive: true });
  window.addEventListener("touchstart", onUserInput, { capture: true, passive: true });
  window.addEventListener("keydown", onUserInput, true);
  window.addEventListener("pointerdown", onUserInput, true);
  // 动画期间关掉滚动锚定，避免浏览器和逐帧 scrollTo 互相修正（同 StickyProfileHeader 回顶）
  root.style.overflowAnchor = "none";

  let startY = window.scrollY;
  const initial = target() - startY;
  if (!reduce && Math.abs(initial) > FAR_SCREENS * window.innerHeight) {
    window.scrollTo({ top: target() - Math.sign(initial) * window.innerHeight, behavior: "instant" });
    startY = window.scrollY;
  }
  const duration = reduce
    ? 0
    : Math.min(1400, 400 + 200 * Math.log(1 + Math.abs(target() - startY) / 200));
  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const t0 = performance.now();
  let settleFrames = 0;
  let stableFrames = 0;

  const step = (now: number) => {
    const p = duration > 0 ? Math.min(1, (now - t0) / duration) : 1;
    if (p < 1) {
      // html 设了 scroll-behavior: smooth，逐帧滚动必须显式 instant
      window.scrollTo({ top: Math.round(startY + (target() - startY) * ease(p)), behavior: "instant" });
      raf = requestAnimationFrame(step);
      return;
    }
    // 校正阶段：顶栏收起（300ms 过渡）等布局变化会让落点漂移
    const t = target();
    if (Math.abs(window.scrollY - t) > 1) {
      window.scrollTo({ top: t, behavior: "instant" });
      stableFrames = 0;
    } else {
      stableFrames++;
    }
    if (stableFrames >= 2 || ++settleFrames > 20) {
      stop(true);
      return;
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => stop();
}

type Row = EntryOutlineItem & { width: number; gapBefore: boolean; date: string; label: string };
type Tip = { i: number; top: number; shown: boolean };

/**
 * 博客列表左侧的滚动时间轴（仿 Notion 目录缩略导航）：每篇一条横线，横线长度按正文字数，
 * 当前阅读的那篇高亮；悬停显示日期与字数，点击跳转，未加载的文章逐页补载后再跳。
 * 只在宽屏且有精确指针（鼠标/触控板）时渲染。
 */
export const EntriesTimeline = memo(function EntriesTimeline({
  outline,
  items,
  hasMore,
  visible,
  pendingEntryId,
  requestEntry,
}: {
  outline: EntryOutlineItem[];
  items: Diary[];
  hasMore: boolean;
  visible: boolean;
  pendingEntryId: string | null;
  requestEntry: (id: string | null) => void;
}) {
  const wide = useSyncExternalStore(
    subscribeWidePointer,
    () => window.matchMedia(WIDE_POINTER_QUERY).matches,
    () => false,
  );
  const enabled = wide && outline.length >= 2;

  const rows = useMemo<Row[]>(() => {
    const yearOf = (at: string) => {
      const d = new Date(at);
      return Number.isNaN(d.getTime()) ? null : d.getFullYear();
    };
    return outline.map((o, i) => {
      const prev = outline[i - 1];
      const gapBefore =
        !!prev && ((!!prev.pinned && !o.pinned) || (!o.pinned && yearOf(o.at) !== yearOf(prev.at)));
      const date = formatDate12h(o.at).split(" ")[0] ?? "";
      const parts = [o.pinned ? "置顶" : "", date, o.words > 0 ? `${o.words.toLocaleString("zh-CN")} 字` : "", o.isPublic === false ? "私密" : ""].filter(Boolean);
      return { ...o, width: lineWidth(o.words), gapBefore, date, label: parts.join("，") };
    });
  }, [outline]);
  const indexById = useMemo(() => new Map(outline.map((o, i) => [o.id, i])), [outline]);

  const [active, setActive] = useState(0);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [jumpingId, setJumpingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [edges, setEdges] = useState({ up: false, down: false });
  const [liveMsg, setLiveMsg] = useState("");

  const navRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** 点击跳转后锁定高亮，直到用户自己滚动；settledY 为跳转动画结束时的位置 */
  const lockRef = useRef<{ index: number; settledY: number | null } | null>(null);
  const cancelScrollRef = useRef<(() => void) | null>(null);
  /** 本次跳转由键盘（Enter）触发：落定后把焦点交给目标文章 */
  const viaKeyboardRef = useRef(false);
  /** 补载完成、开始滚向目标：此后的页面滚动是跳转本身，不算用户取消 */
  const landingRef = useRef(false);
  /** 立即按当前滚动位置重算高亮（跳转失败/取消后清锁时调用） */
  const recomputeRef = useRef<() => void>(() => {});
  const activeRef = useRef(0);
  /** 首次挂载先透明，下一帧再淡入 */
  const [appeared, setAppeared] = useState(false);
  const pointerRef = useRef<{ inside: boolean; x: number; y: number }>({ inside: false, x: 0, y: 0 });
  const lastRailWheelAtRef = useRef(0);
  const failTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rowEl = useCallback(
    (i: number) => containerRef.current?.querySelector<HTMLElement>(`a[data-i="${i}"]`) ?? null,
    [],
  );
  const showTip = useCallback(
    (i: number) => {
      const a = rowEl(i);
      const nav = navRef.current;
      if (!a || !nav) return;
      const r = a.getBoundingClientRect();
      setTip({ i, top: r.top + r.height / 2 - nav.getBoundingClientRect().top, shown: true });
    },
    [rowEl],
  );
  // 隐藏时保留上一次的文字和位置，只做淡出，避免空白胶囊闪到轨道顶端
  const hideTip = useCallback(() => setTip((t) => (t && t.shown ? { ...t, shown: false } : t)), []);
  const updateEdges = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const up = c.scrollTop > 1;
    const down = c.scrollTop + c.clientHeight < c.scrollHeight - 1;
    setEdges((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  }, []);

  /* ── 当前阅读的是哪篇：阅读线以上的最后一篇（二分查找，每帧最多一次） ── */
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const lock = lockRef.current;
      if (lock) {
        if (lock.settledY === null || Math.abs(window.scrollY - lock.settledY) <= 4) return;
        lockRef.current = null; // 跳转落定后用户滚动（含拖滚动条）→ 恢复自动判断
      }
      if (items.length === 0) return;
      const first = document.getElementById(`entry-${items[0].id}`);
      if (!first) return;
      const line = (parseFloat(getComputedStyle(first).scrollMarginTop) || 96) + READING_SLACK;
      let lo = 0;
      let hi = items.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const el = document.getElementById(`entry-${items[mid].id}`);
        if (el && el.getBoundingClientRect().top <= line) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      // 列表已到底：最后几篇滚不到阅读线，最后一篇整篇进入视口即算读到最后一篇。
      // 只在页面确实滚动过时生效（整页放得下时不算）；不用 scrollHeight，彩蛋下拉会改变它
      const root = document.documentElement;
      const lastEl = document.getElementById(`entry-${items[items.length - 1].id}`);
      if (
        !hasMore &&
        lastEl &&
        window.scrollY > 0 &&
        root.scrollHeight - window.innerHeight > 4 &&
        lastEl.getBoundingClientRect().bottom <= window.innerHeight
      )
        ans = items.length - 1;
      const idx = indexById.get(items[ans].id);
      if (idx !== undefined) setActive(idx);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    const unlock = (e: Event) => {
      if (!lockRef.current || insideTimeline(e.target)) return;
      lockRef.current = null;
      schedule();
    };
    recomputeRef.current = schedule;
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("wheel", unlock, { capture: true, passive: true });
    window.addEventListener("touchstart", unlock, { capture: true, passive: true });
    // 展开/收起正文、图片与 mermaid 加载会改变布局但不产生滚动事件
    const main = document.getElementById("entries");
    const ro = main ? new ResizeObserver(schedule) : null;
    if (main && ro) ro.observe(main);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("wheel", unlock, true);
      window.removeEventListener("touchstart", unlock, true);
      recomputeRef.current = () => {};
      ro?.disconnect();
    };
  }, [enabled, items, hasMore, indexById]);

  /* ── 轨道隐藏后再出现（缩放/改窗口宽度跨过 1080px）：清掉悬停与焦点残留，并淡入 ── */
  useEffect(() => {
    if (!enabled) return;
    pointerRef.current.inside = false;
    const raf = requestAnimationFrame(() => {
      setTip(null);
      setFocusIdx(null);
      setAppeared(true);
    });
    return () => {
      cancelAnimationFrame(raf);
      setAppeared(false);
    };
  }, [enabled]);

  /* ── 轨道跟随：当前篇保持在轨道中部（指针在轨道上、键盘在轨道内、刚在轨道上滚过时不动） ── */
  const follow = useCallback(
    (instant: boolean) => {
      const c = containerRef.current;
      if (!c) return;
      if (
        pointerRef.current.inside ||
        c.contains(document.activeElement) ||
        performance.now() - lastRailWheelAtRef.current < FOLLOW_IDLE_MS
      )
        return;
      const a = rowEl(activeRef.current);
      if (!a) return;
      c.scrollTo({
        top: a.offsetTop + ROW_H / 2 - c.clientHeight / 2,
        behavior: instant || prefersReducedMotion() ? "instant" : "smooth",
      });
    },
    [rowEl],
  );
  useEffect(() => {
    activeRef.current = active;
    if (enabled) follow(false);
  }, [enabled, active, follow]);
  useEffect(() => {
    if (!enabled) return;
    const onResize = () => follow(true);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, follow]);

  /* ── 轨道滚轮：容器是 overflow-hidden，由这里代为滚动 ──
   * 不用 overflow-y-auto：Chrome 会把键盘滚动（空格/PageDown/方向键）交给最近点击过的可滚动容器，
   * 点完横线后再按键翻页，滚的是轨道而不是页面。 */
  useEffect(() => {
    const c = containerRef.current;
    if (!enabled || !c) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // Ctrl+滚轮、触控板捏合是页面缩放
      const max = c.scrollHeight - c.clientHeight;
      if (max <= 0) return; // 一屏放得下：滚轮照常滚页面
      e.preventDefault(); // 滚到头也不带动页面
      lastRailWheelAtRef.current = performance.now();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * c.clientHeight : e.deltaY;
      c.scrollTop = Math.max(0, Math.min(max, c.scrollTop + dy));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [enabled]);

  /* ── 渐隐遮罩只加在还有截断内容的一端 ── */
  useEffect(() => {
    if (!enabled) return;
    const raf = requestAnimationFrame(updateEdges);
    window.addEventListener("resize", updateEdges);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateEdges);
    };
  }, [enabled, rows, updateEdges]);

  useEffect(
    () => () => {
      cancelScrollRef.current?.();
      if (failTimerRef.current) clearTimeout(failTimerRef.current);
    },
    [],
  );

  const startScroll = useCallback((el: HTMLElement, label: string) => {
    cancelScrollRef.current?.();
    const lock = lockRef.current;
    const viaKeyboard = viaKeyboardRef.current;
    let cancelAnim: (() => void) | null = null;
    let waitRaf = 0;
    const waitStart = performance.now();
    const begin = () => {
      waitRaf = 0;
      // 顶栏回顶动画不可中断，同时滚动会被它拉回页顶：等它结束
      if (document.documentElement.dataset.returnToTop && performance.now() - waitStart < HEADER_WAIT_MS) {
        waitRaf = requestAnimationFrame(begin);
        return;
      }
      cancelAnim = scrollToEntry(el, (completed) => {
        if (cancelScrollRef.current === cancel) cancelScrollRef.current = null;
        if (lock && lockRef.current === lock) lock.settledY = window.scrollY;
        if (completed && viaKeyboard) {
          if (!el.hasAttribute("tabindex")) {
            el.setAttribute("tabindex", "-1");
            el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
          }
          el.focus({ preventScroll: true });
        }
        if (completed) setLiveMsg(`已跳到 ${label}`);
      });
    };
    const cancel = () => {
      if (waitRaf) cancelAnimationFrame(waitRaf);
      cancelAnim?.();
      if (cancelScrollRef.current === cancel) cancelScrollRef.current = null;
    };
    cancelScrollRef.current = cancel;
    begin();
  }, []);

  const fail = useCallback((id: string) => {
    lockRef.current = null;
    recomputeRef.current();
    setFailedId(id);
    setLiveMsg("未能载入这篇文章");
    if (failTimerRef.current) clearTimeout(failTimerRef.current);
    failTimerRef.current = setTimeout(() => {
      failTimerRef.current = null;
      setFailedId((cur) => (cur === id ? null : cur));
    }, FAIL_SHOW_MS);
  }, []);

  const jump = useCallback(
    (i: number) => {
      const row = outline[i];
      if (!row) return;
      // 地址栏残留的 #entry- 会让深链逻辑在之后每次翻页时把页面拉回旧锚点
      if (window.location.hash.startsWith("#entry-")) {
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      }
      setFailedId(null);
      // 先中止上一次跳转动画（它的回调会写旧锁），再建新锁
      cancelScrollRef.current?.();
      lockRef.current = { index: i, settledY: null };
      setActive(i);
      const el = document.getElementById(`entry-${row.id}`);
      if (el) {
        setJumpingId(null);
        requestEntry(null);
        startScroll(el, rows[i]?.label ?? "");
        return;
      }
      landingRef.current = false;
      setJumpingId(row.id);
      requestEntry(row.id);
      setLiveMsg("正在载入更早的文章");
    },
    [outline, rows, requestEntry, startScroll],
  );

  /* ── 等待补页：加载到就滚过去；hook 放弃或已无更多页就失败 ── */
  useEffect(() => {
    if (!jumpingId) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`entry-${jumpingId}`);
      if (el) {
        setJumpingId(null);
        requestEntry(null);
        setLiveMsg("");
        landingRef.current = true;
        const i = indexById.get(jumpingId);
        startScroll(el, i === undefined ? "" : (rows[i]?.label ?? ""));
      } else if (pendingEntryId !== jumpingId || !hasMore) {
        setJumpingId(null);
        requestEntry(null);
        fail(jumpingId);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [jumpingId, items, pendingEntryId, hasMore, requestEntry, startScroll, fail, indexById, rows]);

  /* ── 等待期间：超时失败；用户在页面上继续阅读（滚轮、触摸、点击、滚动页面）或按 Esc 即取消 ── */
  useEffect(() => {
    if (!jumpingId) return;
    const startedAt = performance.now();
    let startY = window.scrollY;
    const abandon = () => {
      lockRef.current = null;
      recomputeRef.current();
      setJumpingId(null);
      setLiveMsg("");
      requestEntry(null);
    };
    const cancel = (e: Event) => {
      if (landingRef.current) return;
      if (e.type === "scroll") {
        if (document.documentElement.dataset.returnToTop) {
          startY = window.scrollY; // 顶栏回顶动画在拉动页面，不是用户在读
          return;
        }
        if (Math.abs(window.scrollY - startY) > CANCEL_SCROLL_PX) abandon();
        return;
      }
      if (e.type === "keydown") {
        if ((e as globalThis.KeyboardEvent).key === "Escape") abandon();
        return;
      }
      if (insideTimeline(e.target) || performance.now() - startedAt < 150) return;
      abandon();
    };
    const timer = setTimeout(() => {
      setJumpingId(null);
      requestEntry(null);
      fail(jumpingId);
    }, JUMP_TIMEOUT_MS);
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("scroll", cancel, { passive: true });
    window.addEventListener("keydown", cancel);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("scroll", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, [jumpingId, requestEntry, fail]);

  if (!enabled) return null;

  const tipIndexFromPoint = (x: number, y: number) => {
    const a = document.elementFromPoint(x, y)?.closest<HTMLElement>("a[data-i]");
    return a && containerRef.current?.contains(a) ? Number(a.dataset.i) : null;
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    pointerRef.current = { inside: true, x: e.clientX, y: e.clientY };
    const i = tipIndexFromPoint(e.clientX, e.clientY);
    // 落在跨年间隙里时保持上一条提示，避免穿过间隙时闪烁
    if (i !== null) showTip(i);
  };
  const onPointerLeave = () => {
    pointerRef.current.inside = false;
    if (focusIdx === null) hideTip();
    else showTip(focusIdx);
  };
  const onRailScroll = () => {
    updateEdges();
    const p = pointerRef.current;
    if (p.inside) {
      const i = tipIndexFromPoint(p.x, p.y);
      if (i !== null) showTip(i);
    } else if (focusIdx !== null) {
      showTip(focusIdx);
    }
  };

  const focusRow = (i: number) => {
    const c = containerRef.current;
    const a = rowEl(i);
    if (!c || !a) return;
    a.focus({ preventScroll: true });
    // 只滚轨道，不用 scrollIntoView（会连带滚动页面）
    const top = a.offsetTop;
    if (top < c.scrollTop + ROW_H * 2) c.scrollTop = top - ROW_H * 2;
    else if (top + ROW_H > c.scrollTop + c.clientHeight - ROW_H * 2) c.scrollTop = top + ROW_H * 3 - c.clientHeight;
    setFocusIdx(i);
    if (!pointerRef.current.inside) showTip(i);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = focusIdx ?? active;
    const last = rows.length - 1;
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = cur + 1;
        break;
      case "ArrowUp":
        next = cur - 1;
        break;
      case "PageDown":
        next = cur + 10;
        break;
      case "PageUp":
        next = cur - 10;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    focusRow(Math.max(0, Math.min(last, next)));
  };

  const onRowClick = (e: MouseEvent<HTMLAnchorElement>, i: number) => {
    // 修饰键或非左键：交给浏览器（新标签页打开 #entry-，由深链逻辑定位）
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    viaKeyboardRef.current = e.detail === 0; // Enter 触发的 click 没有点击次数
    jump(i);
  };

  const tabStop = focusIdx ?? active;
  const tipRow = tip ? rows[tip.i] : undefined;
  const tipText = tipRow
    ? tipRow.id === jumpingId
      ? "载入中…"
      : tipRow.id === failedId
        ? "未能载入"
        : [tipRow.pinned ? "置顶" : "", tipRow.date, tipRow.words > 0 ? `${tipRow.words.toLocaleString("zh-CN")} 字` : "", tipRow.isPublic === false ? "私密" : ""]
            .filter(Boolean)
            .join(" · ")
    : "";
  const mask =
    edges.up || edges.down
      ? `linear-gradient(to bottom, ${edges.up ? "transparent" : "#000"}, #000 24px, #000 calc(100% - 24px), ${edges.down ? "transparent" : "#000"})`
      : undefined;

  return (
    <nav
      ref={navRef}
      data-entries-timeline
      aria-label="文章时间轴"
      inert={!visible}
      className={`fixed left-0 top-1/2 z-40 w-14 -translate-y-1/2 transition-opacity duration-500 motion-reduce:transition-none ${
        visible && appeared ? "opacity-100" : "opacity-0"
      }`}
    >
      <div
        ref={containerRef}
        className="relative overflow-hidden py-1"
        style={{ maxHeight: "max(160px, calc(100vh - 192px))", maskImage: mask, WebkitMaskImage: mask }}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onScroll={onRailScroll}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          const i = Number((e.target as HTMLElement).dataset.i);
          if (Number.isNaN(i)) return;
          setFocusIdx(i);
          if (!pointerRef.current.inside) showTip(i);
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setFocusIdx(null);
          if (!pointerRef.current.inside) hideTip();
        }}
      >
        <ol>
          {rows.map((r, i) => {
            const isActive = i === active;
            const isLoading = r.id === jumpingId;
            const color = isActive || isLoading
              ? "bg-zinc-900/85 dark:bg-white/90 forced-colors:bg-[Highlight]"
              : r.isPublic === false
                ? "bg-zinc-900/10 group-hover:bg-zinc-900/50 group-focus-visible:bg-zinc-900/50 dark:bg-white/10 dark:group-hover:bg-white/55 dark:group-focus-visible:bg-white/55 forced-colors:bg-[GrayText]"
                : "bg-zinc-900/20 group-hover:bg-zinc-900/50 group-focus-visible:bg-zinc-900/50 dark:bg-white/20 dark:group-hover:bg-white/55 dark:group-focus-visible:bg-white/55 forced-colors:bg-[CanvasText]";
            return (
              <li key={r.id} className={r.gapBefore ? "mt-2" : undefined}>
                <a
                  href={`#entry-${r.id}`}
                  data-i={i}
                  tabIndex={i === tabStop ? 0 : -1}
                  aria-label={r.label}
                  aria-current={isActive ? "location" : undefined}
                  aria-busy={isLoading || undefined}
                  onClick={(e) => onRowClick(e, i)}
                  // Chrome 会在鼠标点击链接时聚焦它：焦点留在轨道会让提示常驻、方向键被轨道接管
                  onMouseDown={(e) => e.preventDefault()}
                  // 全局 :focus-visible 描边会压住相邻横线；键盘焦点改由横线变色和提示框表示
                  style={{ outline: "none" }}
                  className="group flex h-2 w-14 items-center pl-4"
                >
                  <span
                    aria-hidden
                    className={`block h-0.5 rounded-full transition-colors duration-200 motion-reduce:transition-none ${color} ${
                      isLoading ? "motion-safe:animate-pulse" : ""
                    }`}
                    style={{ width: r.width }}
                  />
                </a>
              </li>
            );
          })}
        </ol>
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute left-[60px] -translate-y-1/2 whitespace-nowrap rounded-lg bg-white/80 px-2 py-1 text-[0.72rem] tabular-nums text-zinc-600 shadow-sm ring-1 ring-black/5 backdrop-blur-md transition-opacity duration-150 dark:bg-zinc-900/80 dark:text-zinc-300 dark:ring-white/10 ${
          tip?.shown ? "opacity-100" : "opacity-0"
        }`}
        style={{ top: tip?.top ?? 0 }}
      >
        {tipText}
      </div>
      <p className="sr-only" aria-live="polite">
        {liveMsg}
      </p>
    </nav>
  );
});
