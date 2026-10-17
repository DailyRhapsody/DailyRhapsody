// node --experimental-test-module-mocks --test tests/persona-title-markers.test.mjs
//
// 转换层给 callout / toggle 的私有标记不能进检索索引，也不能被 postTitle 当标题。
// 数字人的回答会引用 postTitle，标记泄漏到那里就等于对外露内部协议。
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

const { postTitle } = await import("../lib/persona/retrieve.ts");
const { makeCorpus } = await import("../lib/persona/first-principles.ts");
const { makeValuesCorpus } = await import("../lib/persona/core-values.ts");

const entry = (summary) => ({ id: "x", date: "2026-01-01", summary });

test("toggle 打头的正文，标题取折叠块标题而不是私有标记", () => {
  assert.equal(
    postTitle(entry("> [!NOTION-TOGGLE] 折叠标题\n>\n> 内容")),
    "折叠标题"
  );
});

test("callout 打头的正文，标题取标注内容", () => {
  assert.equal(
    postTitle(entry("> [!NOTION-CALLOUT] 💡\n> 提醒内容")),
    "提醒内容"
  );
});

test("普通正文的标题规则不变", () => {
  assert.equal(postTitle(entry("今天读完了这本书。\n\n后面还有一段")), "今天读完了这本书");
});

test("两份分析语料都不含私有标记与引用前缀，但保留列表结构", () => {
  const article = {
    id: "a1",
    date: "2026-01-01",
    isPublic: true,
    bodyStatus: "complete",
    summary: "> [!NOTION-TOGGLE] 开关\n>\n> - 条目\n>   - 子条目\n\n正文",
  };
  for (const corpus of [makeCorpus([article]), makeValuesCorpus([article])]) {
    const text = corpus.chunks.map((c) => c.text).join("\n");
    assert.ok(!text.includes("NOTION"), text);
    assert.ok(!/^[ \t]*>/m.test(text), text);
    assert.ok(text.includes("- 条目"), text);
    assert.ok(text.includes("  - 子条目"), text);
  }
});
