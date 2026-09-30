import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";

// 创建时间由 Notion 返回为 UTC；博客日历按作者所在的中国时区归档，
// 不能直接截取 UTC 日期，否则北京时间凌晨的文章会落到前一天。
const createdDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Date 支持手填日期和 Notion 自动创建时间；两者都输出既有 Diary 日期字段。 */
export function extractNotionDiaryDate(
  page: Pick<PageObjectResponse, "properties" | "created_time">
): { date: string; publishedAt?: string } {
  const prop = page.properties["Date"];
  if (prop?.type === "date" && prop.date?.start) {
    const start = prop.date.start;
    return {
      date: start.slice(0, 10),
      // 旧的纯日期保留原值；只有实际包含时间时才提供精确时间戳。
      ...(start.length > 10 ? { publishedAt: new Date(start).toISOString() } : {}),
    };
  }

  const createdAt = new Date(
    prop?.type === "created_time" ? prop.created_time : page.created_time
  );
  return {
    date: createdDayFormatter.format(createdAt),
    publishedAt: createdAt.toISOString(),
  };
}
