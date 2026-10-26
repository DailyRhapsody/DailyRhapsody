// node --experimental-test-module-mocks --test tests/reference-focus-selection.test.mjs
//
// 守卫：Reference 列表的「选中」只作排行榜定位（?focus=），不常驻、不自带说明条。
//  - 页面不得再渲染「已选中：… 取消选中」提示条与其 i18n 文案
//  - 撤销方式是点卡片以外的空白处：排除清单必须放过卡片与交互元素
//  - 卡片本体是选中开关，不能在上面直接开详情页；详情只走标题与「阅读」
//  - 高亮仍由 URL 的 focus 驱动
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const feed = readFileSync(new URL("../app/(feed)/reference/ReferenceFeed.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("../components/ReferenceCard.tsx", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../lib/i18n.ts", import.meta.url), "utf8");

test("选中提示条已删除，撤销只靠点空白处", () => {
  assert.equal(i18n.includes("reference.selected."), false, "i18n 里不应再有选中提示条的文案");
  assert.equal(feed.includes("reference.selected."), false, "列表页不应再加回选中提示条");
  assert.match(feed, /params\.delete\("focus"\)/, "点空白处清除 focus 的监听不能丢");
});

test("清除 focus 的监听必须放过卡片与交互元素", () => {
  const guards = feed.match(/closest\("[^"]+"\)/g) ?? [];
  const blankClick = guards.find((line) => line.includes("[data-ref-card]"));
  assert.ok(blankClick, "空白点击的排除清单必须包含 [data-ref-card]");
  for (const selector of ["a", "button", "input", "select", "textarea"]) {
    assert.ok(
      blankClick.includes(selector),
      `排除清单缺少 ${selector}：点卡片链接或工具条时会误清选中`,
    );
  }
});

test("卡片本体是选中开关，不自带详情跳转", () => {
  assert.match(feed, /onSelect=\{toggleSelect\}/, "列表必须把选中回调接到卡片上");
  assert.match(card, /onSelect\?\.\(item\.id\)/, "卡片点击应切选中");
  assert.equal(card.includes("window.open"), false, "卡片本体不得直接开详情页");
  assert.equal(card.includes("openDetail"), false, "卡片本体不得保留详情跳转函数");
  assert.match(card, /href=\{`\/reference\/\$\{item\.id\}`\}/, "标题与「阅读」仍是详情入口");
});

test("高亮仍由 URL 的 focus 驱动", () => {
  assert.match(feed, /searchParams\.get\("focus"\)/, "选中来源应仍是 URL 的 focus 参数");
  assert.match(feed, /selected=\{selectedId === it\.id\}/, "卡片高亮应仍按 focus 比对");
});

test("排行榜定位靠脚本居中，不靠 hash 锚点", () => {
  const shell = readFileSync(new URL("../app/(feed)/FeedShell.tsx", import.meta.url), "utf8");
  assert.equal(
    /focus=\$\{[^}]+\}#reference-/.test(shell),
    false,
    "榜单链接不能再带 #reference- 锚点：锚点是顶对齐，会停在上一张卡的位置",
  );
  assert.match(shell, /\/reference\?focus=\$\{encodeURIComponent\(item\.id\)\}/, "榜单链接只带 focus 参数");
  // 参考卡在 3D 面板里，可视 rect 与布局坐标不一致；必须用 offsetTop 链算位置并二次校正。
  assert.match(feed, /offsetTop/, "定位必须用布局坐标（offsetTop 链）计算");
  assert.match(feed, /scrollTo\(\{/, "定位应走 window.scrollTo 而不是 scrollIntoView");
  assert.equal(feed.includes("scrollIntoView("), false, "不要退回 scrollIntoView：3D 面板里会偏");
  assert.match(feed, /setTimeout\(\(\) => \{[\s\S]{0,200}Math\.abs\(delta\) > 8/, "滚动后要再做一次校正");
});
