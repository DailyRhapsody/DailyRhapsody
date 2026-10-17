// node --experimental-test-module-mocks --test tests/markdown-render.test.mjs
//
// lib/markdown.ts 用 "@/..." 别名引用同仓库模块。Node 不认识 tsconfig paths，
// t.mock.module 也救不了（mock 仍会先解析原始 specifier，报 ERR_MODULE_NOT_FOUND）。
// 唯一可行的写法是注册 resolve 钩子（同 tests/core-values.test.mjs 的做法）。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier.startsWith("@/")
        ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href
        : specifier,
      context
    );
  },
});
after(() => hooks.deregister());

const { renderMarkdown, entrySummaryProseClass, markdownPreviewProseClass } =
  await import("../lib/markdown.ts");

/** marked 会在块之间插入换行；结构断言只看标签序列，先把空白压掉。 */
const compact = (html) => html.replace(/\s+/g, "");

test("三级无序列表必须嵌套，而不是平铺成兄弟", () => {
  const html = renderMarkdown("- 一级\n  - 二级\n    - 三级");
  assert.ok(
    compact(html).includes(
      "<ul><li>一级<ul><li>二级<ul><li>三级</li></ul></li></ul></li></ul>"
    ),
    html
  );
});

test("有序列表里嵌无序子项时，外层 ol 不能被切断", () => {
  const html = renderMarkdown("1. 步骤一\n   - 子项 A\n   - 子项 B\n1. 步骤二");
  const c = compact(html);
  assert.equal((c.match(/<ol>/g) || []).length, 1, html);
  assert.ok(c.includes("<li>步骤一<ul><li>子项A</li><li>子项B</li></ul></li><li>步骤二</li>"), html);
});

test("待办列表能嵌套，复选框仍带 checked/disabled", () => {
  const html = renderMarkdown("- [ ] 任务\n    - [ ] 子任务\n- [x] 已完成");
  const c = compact(html);
  assert.ok(c.includes("任务<ul><li><input"), html);
  assert.equal((c.match(/type="checkbox"/g) || []).length, 3, html);
  assert.ok(c.includes("checked"), html);
  assert.ok(c.includes("disabled"), html);
});

test("toggle 标记渲染成默认展开的 details，且标记本身不外泄", () => {
  const html = renderMarkdown("> [!NOTION-TOGGLE] 开关标题\n>\n> 内容");
  assert.match(html, /<details[^>]*class="dr-toggle"[^>]*open[^>]*>/, html);
  assert.match(html, /<summary>开关标题<\/summary>/, html);
  assert.ok(html.includes("内容"), html);
  assert.ok(!html.includes("[!NOTION-TOGGLE]"), html);
});

test("toggle 标题保留行内格式", () => {
  const html = renderMarkdown("> [!NOTION-TOGGLE] **重点**");
  assert.match(html, /<summary><strong>重点<\/strong><\/summary>/, html);
});

test("toggle 标题里的脚本不会变成可执行标签", () => {
  const html = renderMarkdown("> [!NOTION-TOGGLE] <script>alert(1)</script>");
  assert.ok(!html.includes("<script"), html);
  assert.ok(!html.includes("[!NOTION-TOGGLE]"), html);
});

test("callout 渲染不回归", () => {
  const html = renderMarkdown("> [!NOTION-CALLOUT] 💡\n> 提醒内容");
  assert.match(html, /class="dr-callout"/, html);
  assert.match(html, /class="dr-callout-icon">💡</, html);
  assert.ok(html.includes("提醒内容"), html);
  assert.ok(!html.includes("[!NOTION-CALLOUT]"), html);
});

test("表格、分割线、引用等基础块仍正常", () => {
  const table = renderMarkdown("| 列一 | 列二 |\n| --- | --- |\n| 1 | 2 |");
  assert.match(table, /<table>/, table);
  assert.match(table, /<th>列一<\/th>/, table);
  assert.match(table, /<td>1<\/td>/, table);

  const hr = renderMarkdown("上\n\n---\n\n下");
  assert.match(hr, /<hr\s*\/?>/, hr);

  const quote = renderMarkdown("> 引用的句子");
  assert.match(quote, /<blockquote>/, quote);
});

test("mermaid 代码块的 pre>code.language-mermaid 契约不变", () => {
  const html = renderMarkdown("```mermaid\ngraph LR\nA-->B\n```");
  assert.match(html, /<pre><code class="language-mermaid">/, html);
});

test("标题仍输出 h1..h6 标签（字号由 CSS 决定，不在 HTML 里）", () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const html = renderMarkdown(`${"#".repeat(level)} 标题${level}`);
    assert.match(html, new RegExp(`<h${level}>标题${level}</h${level}>`), html);
  }
});

test("折叠态类名不含任何标题层级 token，展开态才放开 h1-h3", () => {
  const folded = entrySummaryProseClass(false);
  const expanded = entrySummaryProseClass(true);

  assert.ok(folded.includes("max-h-36"), folded);
  assert.ok(folded.includes("[&_summary]:pointer-events-none"), folded);
  assert.ok(!/\[&_h[1-6]\]/.test(folded), folded);

  assert.ok(expanded.includes("[&_h1]:text-[1.0625rem]"), expanded);
  assert.ok(expanded.includes("[&_h2]:text-[0.9375rem]"), expanded);
  assert.ok(expanded.includes("[&_h3]:text-[0.875rem]"), expanded);
  assert.ok(expanded.includes("[&_h1]:font-semibold"), expanded);
  assert.ok(!expanded.includes("max-h-36"), expanded);

  // 展开态不加重直外边距：块间距由 space-y-[1.15em] 负责，叠加会外边距合并
  assert.ok(!/\[&_h[1-3]\]:m[tb]-/.test(expanded), expanded);

  // 共享常量必须保持无层级，否则 Reference / 后台预览会被一起改动
  assert.ok(!/\[&_h[1-6]\]/.test(markdownPreviewProseClass), markdownPreviewProseClass);
});
