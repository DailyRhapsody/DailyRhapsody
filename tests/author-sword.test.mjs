import assert from "node:assert/strict";
import { test } from "node:test";

const {
  AUTHOR_SWORD_VERSION,
  AUTHOR_THOUGHT_CORE,
  AUTHOR_STRUCTURE_LAYERS,
  buildAuthorSwordSystemPrompt,
} = await import("../lib/author-sword.ts");

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

test("作者之剑版本固定，思想内核先做层次定位，再落到产权、目的与位置", () => {
  assert.equal(AUTHOR_SWORD_VERSION, "2026-10-21.6");
  for (const key of [
    "层次定位",
    "世界体系",
    "国家/发展阶段",
    "文化/合法性",
    "产权/组织",
    "技术/物质",
    "因果链",
    "所有权与控制权",
    "实权审计",
    "代际时钟",
    "目的函数",
    "三问分开",
    "适用性筛查",
    "反共识",
    "方向必然性",
    "证据硬度",
    "硬条件按顺序否决",
    "代价与人性",
    "对外故事与内部权责",
  ]) {
    assert.match(AUTHOR_THOUGHT_CORE, new RegExp(key));
  }
  for (const key of ["世界体系与地缘", "国家与发展阶段", "文化与合法性", "产权与组织", "技术与物质"]) {
    assert.match(AUTHOR_STRUCTURE_LAYERS, new RegExp(key));
  }
});

test("作者之剑只注入公开判断方式，不注入私密记忆", () => {
  const prompt = buildAuthorSwordSystemPrompt(bundle);
  assert.match(prompt, /## 判断/);
  assert.match(prompt, /## 依据/);
  assert.match(prompt, /## 点评/);
  assert.match(prompt, /## 反证/);
  assert.match(prompt, /## 底稿/);
  assert.match(prompt, /不代表他此刻的观点/);
  assert.equal(prompt.includes("PRIVATE_MEMORY_SENTINEL"), false);
});

test("判断分四行，主导层、公司、目的、位置不合并成总分", () => {
  const prompt = buildAuthorSwordSystemPrompt(bundle);
  assert.match(prompt, /主导层：/);
  assert.match(prompt, /公司：/);
  assert.match(prompt, /目的：/);
  assert.match(prompt, /位置：/);
  assert.match(prompt, /同一条因果链/);
  assert.match(prompt, /公司是结果/);
  assert.match(prompt, /结构与层次/);
  assert.match(prompt, /世界体系\/国家政策/);
  assert.match(prompt, /公司值得投、家族不想做产品、作者不适合去/);
  assert.match(prompt, /只适合可结算的外部身份/);
});

test("先做层次定位，不把所有权当唯一根", () => {
  const prompt = buildAuthorSwordSystemPrompt(bundle);
  assert.match(prompt, /先做层次定位/);
  assert.match(prompt, /不要先验地把所有权放第一/);
  assert.match(prompt, /中力可能由产权与家族主导/);
  assert.match(prompt, /中国机器人可能由国家、发展阶段与地缘主导/);
  assert.match(prompt, /名义职级/);
  assert.match(prompt, /预算谁批/);
  assert.match(prompt, /什么事项能否决/);
  assert.match(prompt, /继承事件/);
  assert.match(prompt, /产品是目的还是手段/);
  assert.match(prompt, /全职与实控只证明控制权集中/);
  assert.match(prompt, /家族企业才写家族传承/);
  assert.match(prompt, /不要套家族模板/);
  assert.match(prompt, /只写以下三行/);
  assert.match(prompt, /未使用私密记忆/);
});

test("硬条件按顺序否决，并给反共识与标签设边界", () => {
  const prompt = buildAuthorSwordSystemPrompt(bundle);
  assert.match(prompt, /任一项不成立就停/);
  assert.match(prompt, /加权平均/);
  assert.match(prompt, /不适用/);
  assert.match(prompt, /不得凭标签定性/);
  assert.match(prompt, /共识方最可能对在哪里/);
  assert.match(prompt, /对外故事与内部权责/);
  assert.match(prompt, /不写投资建议/);
});
