import assert from "node:assert/strict";
import { test } from "node:test";

const { AUTHOR_SWORD_VERSION, AUTHOR_VALUE_AXES, buildAuthorSwordSystemPrompt } = await import(
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

test("作者之剑版本固定，公开价值坐标齐全", () => {
  assert.equal(AUTHOR_SWORD_VERSION, "2026-10-21.1");
  for (const key of ["现实约束", "证据硬度", "利益与结构", "人与团队", "技术与产品", "取舍与长期"]) {
    assert.match(AUTHOR_VALUE_AXES, new RegExp(key));
  }
});

test("作者之剑只注入公开判断方式，不注入私密记忆", () => {
  const prompt = buildAuthorSwordSystemPrompt(bundle);
  assert.match(prompt, /现实约束/);
  assert.match(prompt, /证据硬度/);
  assert.match(prompt, /## 判断/);
  assert.match(prompt, /## 依据/);
  assert.match(prompt, /## 点评/);
  assert.match(prompt, /## 反证/);
  assert.match(prompt, /## 底稿/);
  assert.match(prompt, /不代表他此刻的观点/);
  assert.equal(prompt.includes("PRIVATE_MEMORY_SENTINEL"), false);
});

test("作者之剑要求价值坐标与公司事实同时出现", () => {
  const prompt = buildAuthorSwordSystemPrompt(bundle);
  assert.match(prompt, /同时包含/);
  assert.match(prompt, /证据等级/);
  assert.match(prompt, /谁得利/);
  assert.match(prompt, /不写投资建议/);
});
