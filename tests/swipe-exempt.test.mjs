// node --test tests/swipe-exempt.test.mjs
//
// /blog 的横滑切 tab 不能吞掉正文里本该横滚的块。
//
// useTabSwipeNavigation 把 wheel / touch 监听挂在 document 上，横向意图一律 preventDefault 并
// 累计切 tab。正文里的代码块、宽表格、KaTeX 公式块、Mermaid 图开了 overflow-x-auto（见
// lib/markdown.ts），旧的豁免清单只有 [data-pet-chat] 与 [data-hscroll]：长代码块横滚不动，
// 往右一滑列表直接切到下一个 tab。现在内容确实溢出的块豁免，放得下的块照常切 tab。
import assert from "node:assert/strict";
import { test } from "node:test";

const { isSwipeExempt } = await import("../hooks/useTabSwipeNavigation.ts");

/** 只实现测试用到的选择器：标签名、.class、[attr]，按逗号分隔取并集，沿父链向上找 */
function el({ tag = "div", cls = [], attrs = [], scrollWidth = 300, clientWidth = 300, parent = null } = {}) {
  const node = { tag, cls, attrs, scrollWidth, clientWidth, parent };
  node.closest = (selectorList) => {
    const selectors = selectorList.split(",").map((s) => s.trim());
    for (let cur = node; cur; cur = cur.parent) {
      if (selectors.some((sel) => matches(cur, sel))) return cur;
    }
    return null;
  };
  return node;
}
function matches(node, sel) {
  if (sel.startsWith("[") && sel.endsWith("]")) return node.attrs.includes(sel.slice(1, -1));
  if (sel.startsWith(".")) return node.cls.includes(sel.slice(1));
  return node.tag === sel;
}

const article = el({ tag: "article", cls: ["dr-md"] });
const wide = { scrollWidth: 900, clientWidth: 320 };

test("正文里溢出的块豁免：代码块、宽表格、KaTeX 公式块、Mermaid 图", () => {
  const pre = el({ tag: "pre", parent: article, ...wide });
  assert.equal(isSwipeExempt(el({ tag: "code", parent: pre })), true, "pre > code");
  const table = el({ tag: "table", parent: article, ...wide });
  const td = el({ tag: "td", parent: el({ tag: "tr", parent: el({ tag: "tbody", parent: table }) }) });
  assert.equal(isSwipeExempt(td), true, "table td");
  const katex = el({ tag: "span", cls: ["katex-display"], parent: article, ...wide });
  assert.equal(isSwipeExempt(el({ tag: "span", cls: ["mord"], parent: katex })), true, ".katex-display");
  const mermaid = el({ tag: "figure", cls: ["dr-mermaid"], parent: article, ...wide });
  assert.equal(isSwipeExempt(el({ tag: "svg", parent: mermaid })), true, ".dr-mermaid");
});

test("放得下的块不豁免：短代码块、窄表格上横滑照常切 tab", () => {
  const pre = el({ tag: "pre", parent: article, scrollWidth: 320, clientWidth: 320 });
  assert.equal(isSwipeExempt(el({ tag: "code", parent: pre })), false);
  // 取整误差 1px 不算溢出
  const table = el({ tag: "table", parent: article, scrollWidth: 321, clientWidth: 320 });
  assert.equal(isSwipeExempt(el({ tag: "td", parent: table })), false);
});

test("原有豁免不变：数字人面板与卡片条，不看是否溢出", () => {
  assert.equal(isSwipeExempt(el({ tag: "p", parent: el({ attrs: ["data-pet-chat"] }) })), true);
  assert.equal(isSwipeExempt(el({ tag: "button", parent: el({ attrs: ["data-hscroll"] }) })), true);
});

test("普通正文与非元素目标不豁免", () => {
  assert.equal(isSwipeExempt(el({ tag: "p", parent: article })), false);
  assert.equal(isSwipeExempt(null), false);
  assert.equal(isSwipeExempt({}), false);
});
