/**
 * 顶栏布局常量，由 /blog 与 StickyProfileHeader 共享。
 * 修改值时两处会同步生效，避免再次出现手抄数字不一致导致的滚动吸收量错位。
 */

/** 顶栏完全展开时的高度（px） */
export const HEADER_EXPANDED_H = 260;

/** 顶栏折叠（吸顶 pill 态）时的高度（px） */
export const HEADER_COLLAPSED_H = 56;

/** 顶栏收缩量：entries 页 virtualScroll 需要吸收掉这部分才放行原生滚动 */
export const HEADER_COLLAPSE_RANGE = HEADER_EXPANDED_H - HEADER_COLLAPSED_H;

/** 折叠态触发阈值：略大于收缩量以获得稳定 hysteresis */
export const HEADER_COLLAPSE_AT = HEADER_COLLAPSE_RANGE + 10;
