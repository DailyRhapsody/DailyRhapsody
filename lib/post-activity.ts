/**
 * 发文密度口径：日历热力图与「本月 N 篇更新」共用同一份计数。
 *
 * 旧写法从「去重后的日期集合」推导（`[...new Set(entries.map(e => e.date))]`），
 * 同一天发两篇会被折叠成一天：热力图只能二值上色，卡片数字按天计数
 * （实测 2026 年 10 月 9 篇显示成「6 篇更新」）。计数改在这里做一次，
 * 展示层只负责把篇数映射成全站统一的档位。
 */

export type PostCountsByDate = Record<string, number>;

/** 按篇统计每天的发布数。缺日期的条目不参与（与旧 `Set` 口径一致）。 */
export function countPostsByDate(
  entries: { date?: string | null }[],
): PostCountsByDate {
  const counts: PostCountsByDate = {};
  for (const entry of entries) {
    if (!entry.date) continue;
    counts[entry.date] = (counts[entry.date] ?? 0) + 1;
  }
  return counts;
}

/**
 * 本地时区的 `YYYY-MM`。
 *
 * 不能用 `toISOString()`：它是 UTC，北京时间每月 1 日 00:00–08:00 会被算成上个月，
 * 服务端预取与客户端派生出来的「本月」就不是同一个月。
 */
export function monthKeyOf(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

/** 本月发布的篇数（不是「有更新的天数」）。 */
export function countPostsInMonth(
  counts: PostCountsByDate,
  now: Date = new Date(),
): number {
  const prefix = `${monthKeyOf(now)}-`;
  let total = 0;
  for (const [date, count] of Object.entries(counts)) {
    if (date.startsWith(prefix)) total += count;
  }
  return total;
}

/**
 * 热力图档位：0 = 没发，1/2/3 = 当天 1/2/3 篇，4 = 4 篇及以上。
 *
 * 为什么是固定阈值而不是 GitHub 那种「按个人分布取四分位」：本站 220 个发文日里
 * 185 天只有 1 篇（84%），非零值的四分位全部落在 1，按分位分档会得到一个只有
 * 一档有效的假梯度。上限截到 4 是因为 4 篇以上只有 5 天，再细分不可辨。
 */
export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export function activityLevel(count: number): ActivityLevel {
  if (count <= 0) return 0;
  if (count >= 4) return 4;
  return count as ActivityLevel;
}
