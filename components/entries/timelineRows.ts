import { formatDate12h } from "@/lib/format";
import type { TimelineRow } from "./ScrollTimeline";
import type { EntryOutlineItem, MomentOutlineItem } from "./types";

/** 横线宽度范围（px） */
const MIN_W = 6;
const MAX_W = 28;
/** 博客：10 字及以下最短，3000 字及以上最长，中间按对数映射 */
const WORDS_LO = 10;
const WORDS_HI = 3000;
/** 动态：1 张图（或 1 段视频）最短，9 张及以上最长，线性映射 */
const MEDIA_HI = 9;

const widthAt = (t: number) => Math.round(MIN_W + (MAX_W - MIN_W) * Math.min(1, Math.max(0, t)));
const dateOf = (at: string) => formatDate12h(at).split(" ")[0] ?? "";

export function entryLineWidth(words: number) {
  return widthAt((Math.log1p(words) - Math.log(WORDS_LO + 1)) / (Math.log(WORDS_HI + 1) - Math.log(WORDS_LO + 1)));
}

export function momentLineWidth(count: number) {
  return widthAt((count - 1) / (MEDIA_HI - 1));
}

export function entryTimelineRows(outline: EntryOutlineItem[]): TimelineRow[] {
  return outline.map((o) => {
    const parts = [
      o.pinned ? "置顶" : "",
      dateOf(o.at),
      o.words > 0 ? `${o.words.toLocaleString("zh-CN")} 字` : "",
      o.isPublic === false ? "私密" : "",
    ].filter(Boolean);
    return {
      id: o.id,
      at: o.at,
      width: entryLineWidth(o.words),
      line1: parts.join(" · "),
      line2: o.excerpt,
      label: [...parts, o.excerpt ?? ""].filter(Boolean).join("，"),
      pinned: o.pinned,
      muted: o.isPublic === false,
    };
  });
}

export function momentTimelineRows(outline: MomentOutlineItem[]): TimelineRow[] {
  return outline.map((o) => {
    const parts = [dateOf(o.at), o.video ? "视频" : `${o.count} 张图`];
    return {
      id: o.id,
      at: o.at,
      width: momentLineWidth(o.count),
      line1: parts.join(" · "),
      label: parts.join("，"),
    };
  });
}
