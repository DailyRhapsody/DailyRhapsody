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
          className="absolute whitespace-nowrap"
          style={{
            left: `${p.x}px`,
            top: `${p.y}px`,
            fontSize: `${p.fontSize}px`,
            lineHeight: 1.25,
            fontWeight: p.bold ? 700 : 500,
            color: `color-mix(in srgb, var(--dr-cloud-accent) ${Math.round(p.alpha * 100)}%, transparent)`,
          }}
        >
          {p.name}
        </li>
      ))}
    </ul>
  );
});
