// node --experimental-test-module-mocks --test tests/reference-focus-selection.test.mjs
//
// 守卫：Reference 列表的「选中」只作排行榜定位（?focus=），不常驻、不自带说明条。
//  - 页面不得再渲染「已选中：… 取消选中」提示条与其 i18n 文案
//  - 撤销方式是点卡片以外的空白处：排除清单必须放过卡片与交互元素
//  - 高亮仍由 URL 的 focus 驱动
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const feed = readFileSync(new URL("../app/(feed)/reference/ReferenceFeed.tsx", import.meta.url), "utf8");
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

test("高亮仍由 URL 的 focus 驱动", () => {
  assert.match(feed, /searchParams\.get\("focus"\)/, "选中来源应仍是 URL 的 focus 参数");
  assert.match(feed, /selected=\{selectedId === it\.id\}/, "卡片高亮应仍按 focus 比对");
});
