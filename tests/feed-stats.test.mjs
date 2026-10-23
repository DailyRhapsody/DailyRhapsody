// node --experimental-test-module-mocks --test tests/feed-stats.test.mjs
//
// 顶部卡片篇数的可见性口径守卫。
// 2026-10-23 站长实测：以整页加载进入 /reference 时，卡片显示 276（公开篇数），
// 而同一页的 /api/diaries 返回 280。原因是共享 layout 首屏只按公开过滤，而参考 tab
// 不写回客户端的统计值，数字因此一直停在公开口径，切回博客 tab 才自愈。
// 这里锁住「首屏与列表同口径」这条规则，别让 layout 或接口任何一侧退回旧写法。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { visibleDiariesFor } = await import("../lib/feed-stats.ts");

const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const diaries = [
  { id: "pub-1", date: "2026-10-03", isPublic: true },
  { id: "priv-1", date: "2026-10-05", isPublic: false },
  // 日记库缺省按公开（与历史 isPublic !== false 一致）
  { id: "legacy", date: "2026-10-06" },
];

test("访客只拿公开篇，私密与缺省公开的边界都要守住", () => {
  assert.deepEqual(
    visibleDiariesFor(diaries, false).map((d) => d.id),
    ["pub-1", "legacy"],
  );
});

test("站长拿全部，顺序不变", () => {
  assert.deepEqual(
    visibleDiariesFor(diaries, true).map((d) => d.id),
    ["pub-1", "priv-1", "legacy"],
  );
});

test("空语料不抛错，也不产生新数组之外的东西", () => {
  assert.deepEqual(visibleDiariesFor([], false), []);
  assert.deepEqual(visibleDiariesFor([], true), []);
});

test("共享 layout 首屏必须按查看者过滤，别再退回只算公开", () => {
  const layout = read("app/(feed)/layout.tsx");
  assert.match(layout, /isAdmin\(\)/, "layout 要读一次查看者权限");
  assert.match(
    layout,
    /visibleDiariesFor\(diaries \?\? \[\], admin\)/,
    "卡片总数与热力图要走同一个可见性口径",
  );
  assert.match(layout, /totalPosts: visibleDiaries\.length/, "卡片总数取过滤后的可见篇数");
  assert.doesNotMatch(layout, /publicDiaries/, "旧的全公开过滤已被 visibleDiariesFor 取代");
});

test("列表接口与首屏共用同一套可见性判断，不允许两处各写一遍", () => {
  const route = read("app/api/diaries/route.ts");
  assert.match(route, /visibleDiariesFor\(diaries, admin\)/);
  assert.doesNotMatch(route, /diaries\.filter\(\(d\) => d\.isPublic !== false\)/);
});
