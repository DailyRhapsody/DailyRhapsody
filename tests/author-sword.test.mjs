import assert from "node:assert/strict";
import { test } from "node:test";

const { AUTHOR_SWORD_VERSION, AUTHOR_THOUGHT_CORE, buildAuthorSwordSystemPrompt } = await import(
  "../lib/author-sword.ts"
);

const bundle = {
  schema: 1,
  tier: "public",
  builtAt: "2026-10-19T09:00:00.000Z",
  identity: "公开身份",
  voice: "公开语气",
  logic: "现实约束：先问能不能落地。证据硬度：一手材料才算数。",
  memory: "PRIVATE_MEMORY_SENTINEL",
  boundaries: "不聊私事",
  exemplars: [],
  notes: [],
  starters: [],
  avoidTags: [],
  avoidIds: [],
};

test("作者之剑版本固定，思想内核覆盖十年、反共识、窗口与硬条件", () => {
  assert.equal(AUTHOR_SWORD_VERSION, "2026-10-21.2");
  for (const key of [
    "十年尺度",
    "反共识",
    "方向必然性",
    "窗口与核心层",
    "创始人真实性",
    "证据硬度",
    "硬条件取交集",
    "代价与人性",
  ]) {
    assert.match(AUTHOR_THOUGHT_CORE, new RegExp(key));
  }
});

test("作者之剑只注入公开判断方式，不注入私密记忆", () => {
  const prompt = buildAuthorSwordSystemPrompt(bundle);
  assert.match(prompt, /十年尺度/);
  assert.match(prompt, /反共识/);
  assert.match(prompt, /窗口/);
  assert.match(prompt, /## 判断/);
  assert.match(prompt, /## 依据/);
  assert.match(prompt, /## 点评/);
  assert.match(prompt, /## 反证/);
  assert.match(prompt, /## 底稿/);
  assert.match(prompt, /不代表他此刻的观点/);
  assert.equal(prompt.includes("PRIVATE_MEMORY_SENTINEL"), false);
});

test("作者之剑要求硬条件取交集，不用总分掩盖硬伤", () => {
  const prompt = buildAuthorSwordSystemPrompt(bundle);
  assert.match(prompt, /硬条件取交集/);
  assert.match(prompt, /加权平均/);
  assert.match(prompt, /通稿依赖度/);
  assert.match(prompt, /一号位/);
  assert.match(prompt, /不写投资建议/);
});
