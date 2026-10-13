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
 * 基准色由用户指定：**最深一档取热力图的绿**（`CalendarHeatmap` 的
 * `bg-emerald-300/70`），其余档位在它基础上依次变淡。
 * 色值不是估的，是从渲染后的像素取的（合成到卡片真实底色）：
 *   亮色热力图绿 = rgb(142,240,203)，暗色 = rgb(41,147,115)
 *
 * 三档都用**精确 RGB 任意值**，不用透明度修饰符：暗色下需要「比基准更亮」的档位，
 * 而透明度修饰符只能 ≤100%，写 `/120` 会被 Tailwind 丢掉整个 dark 规则、
 * 暗色回落到亮色色值（实测踩过这个坑，表现为暗色第 2/3 档两轮调参都不变）。
 * 亮色档位就是基准色按 100%/85%/70% 合成到白底的结果，等价于透明度写法但不受此限。
 *
 * 「淡」在两个主题下方向相反：亮底上变淡是提亮，暗底上变淡同样要提亮，
 * 所以暗色的档位必须比基准色更亮，不能更暗。
 *
 * 已知代价（实测，见 README 同段）：基准色是 pastel 色，亮色下三档对比度
 * 只有 1.36 / 1.28 / 1.23:1，远低于 WCAG 正文 4.5:1 与大字的 3:1。
 * 本轮以「与热力图一致」的用户要求优先；若要兼顾可读性需同时加深热力图的绿。
 */
const SHADE_CLASS: Record<1 | 2 | 3, string> = {
  1: "text-[rgb(142,240,203)] dark:text-[rgb(41,147,115)]",
  2: "text-[rgb(159,242,211)] dark:text-[rgb(77,166,133)]",
  3: "text-[rgb(176,244,218)] dark:text-[rgb(110,184,150)]",
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
