"use client";

import { memo } from "react";

/** 本月日历热力图：仅方块，始终当前月，有发布的日期高亮；列顺序为周一至周日 */
export const CalendarHeatmap = memo(function CalendarHeatmap({
  datesWithPosts,
}: {
  datesWithPosts: Set<string>;
}) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const firstDay = new Date(y, m, 1);
  const lastDay = new Date(y, m + 1, 0);
  const startWeekday = firstDay.getDay();
  /** 首列对应周一：JS getDay 0=周日 → 周一占位索引为 (d+6)%7 */
  const leadingBlanks = (startWeekday + 6) % 7;
  const daysInMonth = lastDay.getDate();
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = [];
  for (let i = 0; i < leadingBlanks; i++) week.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  function toDateKey(day: number) {
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return (
    <div
      /* 排版口径：四边留白都等于 1px 边框 + 10px 内边距 = 11px，方格保持正方形。
         方块尺寸由列宽决定（7 列 1fr，单元格 aspect-square），所以任何月份
         方格都是同一尺寸，不随当月周数变化。

         纵向余量用 content-between 塞进行间距，而不是 content-center：
         内容盒高 126px，5 行方块共 87px，余下 39px。space-between 让首行贴顶、
         末行贴底，余量全部进到行间，四边留白因此都收在 11px。
         若用 content-center，这 39px 会平分到上下两处，留白涨到 22px；
         若用 stretch，方格会被纵向拉成 17 × 22 的长方形。

         宽度必须是确定值：方块靠列宽定尺寸后，1fr 列的内在宽度归零，
         原来的 min(100%, 168px) 会解析不到基准而让整张卡塌成 46px。
         这里改用与卡片条另外三张相同的 w-[168px]。 */
      className="inline-grid h-[148px] w-[168px] shrink-0 grid-cols-7 content-between gap-1 rounded-xl border border-zinc-200 bg-white/80 p-2.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/80"
    >
      {weeks.flat().map((day, i) =>
        day === null ? (
          <div key={`e-${i}`} className="aspect-square rounded-[4px] bg-zinc-100 dark:bg-zinc-700/60" />
        ) : (
          <div
            key={day}
            className={`aspect-square rounded-[4px] transition-colors ${
              datesWithPosts.has(toDateKey(day))
                ? "bg-emerald-300/70 dark:bg-emerald-400/50"
                : "bg-zinc-200 dark:bg-zinc-600/80"
            }`}
            title={`${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}${datesWithPosts.has(toDateKey(day)) ? " 有发布" : ""}`}
          />
        )
      )}
    </div>
  );
});
