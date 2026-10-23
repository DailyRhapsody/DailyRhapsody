// node --experimental-test-module-mocks --test tests/feed-stats.test.mjs
//
// 顶部卡片篇数的可见性口径与上报时机守卫。
// 2026-10-23 站长实测：以整页加载进入 /reference 时，卡片显示 276（公开篇数），
// 而同一页的 /api/diaries 返回 280。原因是共享 layout 首屏只按公开过滤，而参考 tab
// 不写回客户端的统计值，数字因此一直停在公开口径，切回博客 tab 才自愈。
//
// 两条不变式：
// 1. 首屏、列表接口、热力图共用同一套「谁看得见哪些文章」的判断；
// 2. 客户端只在首屏请求真正成功过之后才写回卡片，参考 tab 永不写回。
//
// 变异对照（每条都应让本文件变红）：
// - layout 里的 `admin = await isAdmin()` 改成丢弃返回值；
// - layout 的热力图改回 countPostsByDate(diaries ?? []);
// - route 里在共用函数之后再叠一层 isPublic 过滤，或把 admin 写死 false；
// - EntriesPageClient 退回 `activeTopTab === 2 ? {} : ...` 的单条件写法。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { shouldPublishEntryStats, visibleDiariesFor } = await import("../lib/feed-stats.ts");
const { countPostsByDate, countPostsInMonth } = await import("../lib/post-activity.ts");

const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

/** 用本机时区拼出「本月」的日期，避免用例随月份滚动失效 */
const thisMonthDate = (day) => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${String(day).padStart(2, "0")}`;
};

const diaries = [
  { id: "pub-1", date: thisMonthDate(3), isPublic: true },
  { id: "pub-2", date: thisMonthDate(3), isPublic: true },
  // 私密文章：访客既不能计入篇数，也不能让它的日期进热力图与「本月」
  { id: "priv-1", date: thisMonthDate(5), isPublic: false },
  // 日记库缺省按公开（与历史 isPublic !== false 一致）
  { id: "legacy", date: thisMonthDate(6) },
];

test("访客口径：私密篇计入零处，热力图与本月也看不到它的日期", () => {
  const visible = visibleDiariesFor(diaries, false);
  assert.deepEqual(
    visible.map((d) => d.id),
    ["pub-1", "pub-2", "legacy"],
  );
  const counts = countPostsByDate(visible);
  assert.equal(Object.prototype.hasOwnProperty.call(counts, thisMonthDate(5)), false);
  assert.equal(counts[thisMonthDate(3)], 2);
  assert.equal(countPostsInMonth(counts), 3);
});

test("站长口径：同一份语料多算那一篇，日期分布同步包含私密日期", () => {
  const visible = visibleDiariesFor(diaries, true);
  assert.deepEqual(
    visible.map((d) => d.id),
    ["pub-1", "pub-2", "priv-1", "legacy"],
  );
  const counts = countPostsByDate(visible);
  assert.equal(counts[thisMonthDate(5)], 1);
  assert.equal(countPostsInMonth(counts), 4);
});

test("空语料就是空结果，不抛错", () => {
  assert.deepEqual(visibleDiariesFor([], false), []);
  assert.deepEqual(visibleDiariesFor([], true), []);
  assert.deepEqual(countPostsByDate(visibleDiariesFor([], true)), {});
});

test("上报时机：首屏未落地不写、参考 tab 不写、真实的 0 篇要能写", () => {
  const cases = [
    [{ activeTopTab: 2, loading: false, firstPageLoaded: true }, false], // 参考页：数字来自首屏
    [{ activeTopTab: 0, loading: true, firstPageLoaded: false }, false], // 首帧：total 还是 0
    [{ activeTopTab: 0, loading: false, firstPageLoaded: false }, false], // 首屏失败：0 不是空列表
    [{ activeTopTab: 1, loading: false, firstPageLoaded: false }, false], // 动态 tab 同样等首屏
    [{ activeTopTab: 0, loading: false, firstPageLoaded: true }, true], // 正常落地（含真实 0 篇）
    [{ activeTopTab: 1, loading: false, firstPageLoaded: true }, true],
  ];
  for (const [input, expected] of cases) {
    assert.equal(shouldPublishEntryStats(input), expected, JSON.stringify(input));
  }
});

test("共享 layout 首屏必须按查看者过滤，篇数与热力图同一份可见集合", () => {
  const layout = read("app/(feed)/layout.tsx");
  // 权限必须真的取到 admin 上：只写 await isAdmin() 而不赋值就退回公开口径
  assert.match(layout, /admin\s*=\s*await\s+isAdmin\(\)/, "isAdmin 的结果必须赋给 admin");
  assert.match(layout, /visibleDiariesFor\(diaries \?\? \[\], admin\)/, "首屏要按查看者过滤");
  assert.match(layout, /totalPosts: visibleDiaries\.length/, "卡片总数取过滤后的可见篇数");
  // 热力图与「本月 N 篇」必须吃同一份过滤结果，否则私密日期会漏给访客
  assert.match(layout, /countPostsByDate\(visibleDiaries\)/, "热力图要基于过滤后的集合");
  assert.doesNotMatch(layout, /countPostsByDate\((diaries|public)/, "热力图不得直接读未过滤的日记");
  // 只对日记做约束：下面的动态与资料库各有自己的 isPublic 默认口径，不在这里管
  assert.doesNotMatch(layout, /diaries[^;\n]{0,40}\.filter\(/, "日记的可见性判断只应有一处");
});

test("列表接口与首屏共用同一套可见性判断，不允许两处各写一遍", () => {
  const route = read("app/api/diaries/route.ts");
  assert.match(route, /const\s+admin\s*=\s*await\s+isAdmin\(\)/, "接口的 admin 必须来自鉴权");
  assert.match(route, /visibleDiariesFor\(diaries, admin\)/);
  assert.doesNotMatch(route, /\.filter\([^;]{0,120}isPublic/, "第二次过滤会把站长的私密篇又剔掉");
});

test("客户端上报走统一判据，且把首屏落地状态传进去", () => {
  const client = read("app/(feed)/blog/EntriesPageClient.tsx");
  assert.match(client, /shouldPublishEntryStats\(\{[^}]*firstPageLoaded/, "上报判据必须拿到首屏落地状态");
  assert.doesNotMatch(client, /activeTopTab === 2 \?/, "旧的单条件写法不得回潮");
  // 「总数非零」不能冒充数据就绪：判据入参里出现 totalPosts 就说明又退回去了
  assert.doesNotMatch(client, /shouldPublishEntryStats\(\{[^}]*totalPosts/, "不能用「总数非零」冒充数据就绪");
});

test("首屏落地标志只在 2xx 成功分支里置真", () => {
  const hook = read("hooks/useEntries.ts");
  const successBlock = hook.slice(hook.indexOf("loadedTagRef.current = tag;"));
  const before = successBlock.slice(0, successBlock.indexOf("if (typeof data.total"));
  assert.match(before, /setFirstPageLoaded\(true\)/, "成功分支要置真");
  assert.equal(
    (hook.match(/setFirstPageLoaded\(true\)/g) ?? []).length,
    1,
    "只能有一处置真，失败路径不得写",
  );
});
