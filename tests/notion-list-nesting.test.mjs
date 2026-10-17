// node --experimental-test-module-mocks --test tests/notion-list-nesting.test.mjs
//
// 验证 Notion 块树 → Markdown 的层级还原：嵌套列表必须带缩进、同一列表项之间
// 必须用单换行（否则 marked 判成 loose list）、toggle 必须留下折叠标记。
// 只 mock @notionhq/client 的传输层，转换逻辑走真实实现。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

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

process.env.NODE_ENV = "test";
process.env.NOTION_TOKEN = "test-notion-token";

const RICH = (text) => ({
  type: "text",
  text: { content: text, link: null },
  plain_text: text,
  href: null,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
});

const blocks = new Map();
const node = (id, type, payload, hasChildren = false) => ({
  object: "block",
  id,
  type,
  has_children: hasChildren,
  [type]: payload,
});
const bullet = (id, text, hasChildren = false) =>
  node(id, "bulleted_list_item", { rich_text: [RICH(text)], color: "default" }, hasChildren);
const numbered = (id, text, hasChildren = false) =>
  node(id, "numbered_list_item", { rich_text: [RICH(text)], color: "default" }, hasChildren);
const todo = (id, text, hasChildren = false, checked = false) =>
  node(id, "to_do", { rich_text: [RICH(text)], color: "default", checked }, hasChildren);
const paragraph = (id, text) =>
  node(id, "paragraph", { rich_text: [RICH(text)], color: "default" });
const toggle = (id, text, hasChildren = false) =>
  node(id, "toggle", { rich_text: [RICH(text)], color: "default" }, hasChildren);
const callout = (id, text, hasChildren = false) =>
  node(id, "callout", { rich_text: [RICH(text)], color: "default", icon: { type: "emoji", emoji: "💡" } }, hasChildren);

const ROOT = "page-root";

test("Notion 块树转换保留嵌套、列表连续性与 toggle 标记", async (t) => {
  t.mock.module("@notionhq/client", {
    namedExports: {
      Client: class {
        constructor({ auth }) {
          assert.equal(auth, "test-notion-token");
        }
        blocks = {
          children: {
            list: async ({ block_id }) => ({
              results: structuredClone(blocks.get(block_id) ?? []),
              has_more: false,
              next_cursor: null,
            }),
          },
        };
      },
      APIResponseError: { isAPIResponseError: () => false },
      APIErrorCode: {},
      RequestTimeoutError: { isRequestTimeoutError: () => false },
    },
  });

  t.after(() => hooks.deregister());
  const { extractBodyMarkdown } = await import("../lib/notion.ts");
  const body = async () => {
    const text = await extractBodyMarkdown(ROOT);
    assert.notEqual(text, null);
    return text;
  };

  await t.test("三层无序列表逐层缩进两个空格", async () => {
    blocks.clear();
    blocks.set(ROOT, [bullet("a", "一级 A", true), bullet("b", "一级 B")]);
    blocks.set("a", [bullet("a1", "二级 A1", true)]);
    blocks.set("a1", [bullet("a1a", "三级 A1a")]);
    assert.equal(
      await body(),
      "- 一级 A\n  - 二级 A1\n    - 三级 A1a\n- 一级 B"
    );
  });

  await t.test("有序列表的子无序项缩进三个空格，且外层编号不被切断", async () => {
    blocks.clear();
    blocks.set(ROOT, [numbered("n1", "步骤一", true), numbered("n2", "步骤二")]);
    blocks.set("n1", [bullet("b1", "子项 A"), bullet("b2", "子项 B")]);
    assert.equal(
      await body(),
      "1. 步骤一\n   - 子项 A\n   - 子项 B\n1. 步骤二"
    );
  });

  await t.test("待办列表的子项缩进四个空格（六格会让 marked 降级成文本）", async () => {
    blocks.clear();
    blocks.set(ROOT, [todo("t1", "任务", true), todo("t2", "已完成", false, true)]);
    blocks.set("t1", [todo("t1a", "子任务")]);
    assert.equal(await body(), "- [ ] 任务\n    - [ ] 子任务\n- [x] 已完成");
  });

  await t.test("列表项里的段落回到列表内，而不是逃成新的顶层段落", async () => {
    blocks.clear();
    blocks.set(ROOT, [bullet("p1", "条目", true)]);
    blocks.set("p1", [paragraph("p1a", "补充段落")]);
    assert.equal(await body(), "- 条目\n\n  补充段落");
  });

  await t.test("toggle 留下私有标记与折叠内容", async () => {
    blocks.clear();
    blocks.set(ROOT, [toggle("tg", "开关标题", true), paragraph("after", "正文")]);
    blocks.set("tg", [paragraph("inner", "折叠里的内容")]);
    assert.equal(
      await body(),
      "> [!NOTION-TOGGLE] 开关标题\n>\n> 折叠里的内容\n\n正文"
    );
  });

  await t.test("callout 标记与子段落不回归", async () => {
    blocks.clear();
    blocks.set(ROOT, [callout("co", "提醒内容", true)]);
    blocks.set("co", [paragraph("co1", "补充一句")]);
    assert.equal(
      await body(),
      "> [!NOTION-CALLOUT] 💡\n>\n> 提醒内容\n>\n> 补充一句"
    );
  });

  await t.test("空列表项输出裸标记，不留尾空格", async () => {
    blocks.clear();
    blocks.set(ROOT, [bullet("empty", "")]);
    assert.equal(await body(), "-");
  });

  await t.test("空待办被丢弃：GFM 要求 ] 后有正文，否则渲染成字面 [ ]", async () => {
    blocks.clear();
    blocks.set(ROOT, [todo("empty", ""), todo("t", "有字")]);
    assert.equal(await body(), "- [ ] 有字");
  });

  await t.test("两栏容器的子内容不会丢", async () => {
    blocks.clear();
    blocks.set(ROOT, [node("cl", "column_list", {}, true), paragraph("tail", "后记")]);
    blocks.set("cl", [node("c1", "column", {}, true), node("c2", "column", {}, true)]);
    blocks.set("c1", [paragraph("p1", "左栏正文")]);
    blocks.set("c2", [paragraph("p2", "右栏正文")]);
    assert.equal(await body(), "左栏正文\n\n右栏正文\n\n后记");
  });

  await t.test("同步块的子内容不会丢", async () => {
    blocks.clear();
    blocks.set(ROOT, [node("sb", "synced_block", { synced_from: null }, true)]);
    blocks.set("sb", [paragraph("s1", "同步内容")]);
    assert.equal(await body(), "同步内容");
  });
});
