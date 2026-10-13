"use client";

import { memo, useMemo } from "react";
import { layoutCloud } from "@/lib/reading-cloud-layout";
import type { ReadingCloud } from "@/lib/weread";

/**
 * 轮播卡里的一屏云图。
 *
 * 卡片沿用卡片条的公共尺寸 168 × 148，云图屏**不写任何字段名**，屏内只有词 ——
 * 168px 宽放不下标题加词两组信息，口径说明只进 aria-label 与悬停提示。
 *
 * 排布是圆形散开而不是逐行换行，布局算法在 lib/reading-cloud-layout.ts（纯函数，
 * 同一份数据每次结果一致，因此不闪烁、不会和 SSR 打架）。
 *
 * 颜色**全部用主题绿**，只靠深浅与字重分层：卡片条其余各张的主色就是这一族绿
 * （曲线、选中态），云图里再混灰阶会显得像两类信息。
 */

/**
 * 名次 → 绿色档位。这里必须写**静态类名**：Tailwind 只扫描源码里出现过的完整类名，
 * 动态拼接（如 `text-emerald-${n}00`）不会生成对应样式。
 *
 * 三档都是实体色，不靠透明度压亮度。早先用「同一色 + 递减 opacity」，
 * 实测白底上末名只有 2.21:1 对比度，且 emerald-600 在白底无论怎么调透明度
 * 都到不了 WCAG 正文的 4.5:1（上限 3.66:1）。层级改由字号、字重与这三档色共同承担。
 * 最浅一档 3.77:1 仍低于正文标准，属有意弱化的层级尾部，已在 README 注明。
 */
const SHADE_CLASS: Record<1 | 2 | 3, string> = {
  1: "text-emerald-700 dark:text-emerald-300",
  2: "text-emerald-700 dark:text-emerald-400",
  3: "text-emerald-600 dark:text-emerald-500",
};

export const ReadingCloudScreen = memo(function ReadingCloudScreen({
  cloud,
}: {
  cloud: ReadingCloud;
}) {
  /*
   * 可用区就是卡片的内容盒：126 × 106（168 × 148 减去 1px 边框与 20px 内边距）。
   *
   * 曾经试过用负 margin 把内边距抵回来、把云图铺到 166px 宽 —— 那是错的：
   * 多出来的部分落在卡片的 padding 上，而卡片是 overflow:hidden，
   * 于是「中信出版集团」被切掉末尾、「机械工业出版社」被切掉开头（实测各切 15~19px）。
   * 现在云图严格排在内容盒内，横向 126 全部可见。
   *
   * 横向变窄后每屏词数也跟着降（作者 4、出版社 3，见 lib/weread.ts）：
   * 126px 宽里 6 个中文词（每个 30~110px 宽）根本散不开。
   */
  const placements = useMemo(() => layoutCloud(cloud.words, 126, 106), [cloud]);

  return (
    <ul
      aria-label={cloud.label}
      className="relative h-full w-full overflow-hidden"
    >
      {placements.map((p) => (
        <li
          key={p.name}
          title={`${p.name} · ${p.note}`}
          className={`absolute whitespace-nowrap ${SHADE_CLASS[p.shade]}`}
          style={{
            left: `${p.x}px`,
            top: `${p.y}px`,
            fontSize: `${p.fontSize}px`,
            lineHeight: 1.25,
            fontWeight: p.bold ? 700 : 500,
          }}
        >
          {p.name}
        </li>
      ))}
    </ul>
  );
});
