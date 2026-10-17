// node --experimental-test-module-mocks --test tests/share-card-plain.test.mjs
//
// 分享图 / 字数 / 时间轴提示共用 summaryToPlainForCard 这条剥离管线。
// 它不经过 renderMarkdown，所以嵌套缩进与私有标记必须在这里单独剥干净。
import assert from "node:assert/strict";
import { test } from "node:test";

const { summaryToPlainForCard } = await import("../lib/share-card.ts");

test("嵌套列表的缩进与标记都被剥掉", () => {
  const plain = summaryToPlainForCard("- 父\n  - 子\n    - 孙");
  assert.equal(plain, "父\n子\n孙");
  assert.ok(!plain.includes("- "), plain);
  assert.ok(!/^[ \t]/m.test(plain), JSON.stringify(plain));
});

test("有序列表与待办标记不留残渣", () => {
  assert.equal(summaryToPlainForCard("1. 一\n2. 二"), "一\n二");
  assert.equal(summaryToPlainForCard("- [ ] 未做\n- [x] 已做"), "未做\n已做");
});

test("callout 的私有标记不进分享图", () => {
  const plain = summaryToPlainForCard("> [!NOTION-CALLOUT] 💡\n> 提醒内容");
  assert.equal(plain, "提醒内容");
  assert.ok(!plain.includes("NOTION"), plain);
});

test("toggle 只去标记、保留标题与内容", () => {
  const plain = summaryToPlainForCard("> [!NOTION-TOGGLE] 开关标题\n>\n> 折叠内容");
  assert.equal(plain, "开关标题\n\n折叠内容");
  assert.ok(!plain.includes("NOTION"), plain);
});

test("details 标签被剥掉", () => {
  const plain = summaryToPlainForCard(
    '<details class="dr-toggle" open><summary>开关</summary><div class="dr-toggle-body">内容</div></details>'
  );
  assert.equal(plain, "开关内容");
  assert.ok(!plain.includes("<details"), plain);
});

test("普通正文不受影响", () => {
  assert.equal(
    summaryToPlainForCard("# 标题\n\n普通一段，带 **加粗** 和 [链接](https://example.com)。"),
    "标题\n\n普通一段，带 加粗 和 链接。"
  );
});
