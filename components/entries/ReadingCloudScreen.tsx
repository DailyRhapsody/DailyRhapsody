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
 * 档位与写作热力图的四档绿一一对齐（`CalendarHeatmap` 的 1 / 2 / 3 / 4 篇及以上），
 * 色值不是估的，是从渲染后的像素取的合成色：
 *   亮色 1 篇 rgb(142,240,203)、2 篇 rgb(51,221,168)、3 篇 rgb(38,198,144)、4+ 篇 rgb(25,163,117)
 *   暗色 1 篇 rgb(18,124,92)、2 篇 rgb(9,168,119)、3 篇 rgb(86,204,159)、4+ 篇 rgb(158,233,199)
 * 云图首名取对比最强的一档（亮色最深、暗色最亮，即 4+ 篇的绿），末名取最浅一档。
 * 热力图只有二值色时，云图最深只能停在「1 篇」那种 pastel 绿；四档之后深度上限随之放开。
 *
 * 用**精确 RGB 任意值**而不是透明度修饰符：暗色档位需要比基准更亮，而透明度修饰符
 * 只能 ≤100%，写 `/120` 会被 Tailwind 丢掉整个 dark 规则、暗色回落到亮色色值（实测踩过）。
 *
 * 深浅方向随主题翻转：亮底上越深 = 名次越高，暗底上越亮 = 名次越高；两主题下都沿
 * 「离卡片底色更远」的方向排，与热力图一致。
 *
 * 已知代价：末名仍是最浅的 pastel 绿，亮色下对比度 1.34:1，低于 WCAG 正文 4.5:1；
 * 那是最小字号、有意弱化的层级尾部，已在 README 注明。
 */
const SHADE_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: "text-[rgb(25,163,117)] dark:text-[rgb(158,233,199)]",
  2: "text-[rgb(38,198,144)] dark:text-[rgb(86,204,159)]",
  3: "text-[rgb(51,221,168)] dark:text-[rgb(9,168,119)]",
  4: "text-[rgb(142,240,203)] dark:text-[rgb(18,124,92)]",
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
