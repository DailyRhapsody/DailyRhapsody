// node --experimental-test-module-mocks --test tests/post-activity.test.mjs
//
// 日历热力图的分档口径守卫。旧实现从「去重后的日期集合」推导，
// 同一天发两篇会被折叠成一天：热力图只能二值上色、「本月 N 篇」按天数计数。
// 这里锁住按篇计数、档位阈值与两处调用点，别让去重口径回潮。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { activityLevel, countPostsByDate, countPostsInMonth, monthKeyOf } =
  await import("../lib/post-activity.ts");

const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("同一天多篇要逐篇计数，而不是去重成一天", () => {
  const counts = countPostsByDate([
    { date: "2026-10-22" },
    { date: "2026-10-22" },
    { date: "2026-10-22" },
    { date: "2026-10-21" },
  ]);
  assert.equal(counts["2026-10-22"], 3);
  assert.equal(counts["2026-10-21"], 1);
  // 旧口径 [...new Set(dates)] 在这里只会得到两个日期、且拿不到篇数
  assert.deepEqual(Object.keys(counts).sort(), ["2026-10-21", "2026-10-22"]);
});

test("没有日期的条目不计数", () => {
  const counts = countPostsByDate([
    { date: "2026-10-01" },
    { date: null },
    { date: "" },
    {},
  ]);
  assert.deepEqual(counts, { "2026-10-01": 1 });
});

test("本月篇数按篇求和：同一天两篇算两篇", () => {
  const counts = { "2026-10-07": 2, "2026-10-13": 1, "2026-09-30": 5 };
  assert.equal(countPostsInMonth(counts, new Date(2026, 9, 22)), 3);
});

test("跨月边界只算本月，且按本地时区取月", () => {
  const counts = { "2026-10-31": 2, "2026-11-01": 4 };
  assert.equal(countPostsInMonth(counts, new Date(2026, 9, 31, 23, 30)), 2);
  assert.equal(countPostsInMonth(counts, new Date(2026, 10, 1, 0, 30)), 4);
  // 东八区今天 00:30 的 UTC 日期还在上月；toISOString 会把它算进 09 月
  assert.equal(monthKeyOf(new Date(2026, 9, 1, 0, 30)), "2026-10");
});

test("档位阈值：0 / 1 / 2 / 3 / 4 篇及以上", () => {
  assert.equal(activityLevel(0), 0);
  assert.equal(activityLevel(1), 1);
  assert.equal(activityLevel(2), 2);
  assert.equal(activityLevel(3), 3);
  assert.equal(activityLevel(4), 4);
  assert.equal(activityLevel(9), 4);
  assert.equal(activityLevel(-1), 0);
});

test("守卫：接口返回按篇计数，不再只给去重日期", () => {
  const route = read("app/api/diaries/route.ts");
  assert.ok(route.includes("dateCounts"), "接口必须返回 dateCounts");
  assert.ok(
    !route.includes("new Set(visible.map((d) => d.date))"),
    "日期去重的旧口径会把同一天多篇折叠掉",
  );
});

test("守卫：热力图读按篇计数，第 1 档保持原视觉基调", () => {
  const heatmap = read("components/entries/CalendarHeatmap.tsx");
  assert.ok(heatmap.includes("dateCounts"), "热力图必须按篇数上色");
  assert.ok(!heatmap.includes("datesWithPosts"), "旧二值口径已废弃");
  for (const cls of [
    "bg-emerald-300/70",
    "bg-emerald-400/80",
    "bg-emerald-500/85",
    "bg-emerald-600/90",
  ]) {
    assert.ok(heatmap.includes(cls), `缺少档位色 ${cls}`);
  }
});
