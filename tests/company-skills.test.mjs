// 公司分析技能目录的守卫：id 唯一、元数据不含提示词、提示词与规则可拼装。
import assert from "node:assert/strict";
import { test } from "node:test";

const { COMPANY_SKILLS, findCompanySkill } = await import("../lib/company-skills.ts");
const { COMPANY_SKILL_PROMPTS, COMPANY_SKILL_RULES, buildCompanySystemPrompt } =
  await import("../lib/company-skill-prompts.ts");

const EXPECTED = [
  "terms",
  "promise",
  "trl",
  "four-causes",
  "concretization",
  "breakdown",
  "research-programme",
  "critical-parts",
  "orders-cash",
  "metrics",
  "translation",
  "moat",
  "field",
  "chaxu",
  "main-conflict",
];

test("十五个技能 id 唯一，顺序固定", () => {
  const ids = COMPANY_SKILLS.map((skill) => skill.id);
  assert.equal(ids.length, 15);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, EXPECTED);
});

test("客户端目录不含提示词，卡片字段齐全", () => {
  for (const skill of COMPANY_SKILLS) {
    assert.equal("prompt" in skill, false, `${skill.id} 不应把提示词带进客户端`);
    assert.match(skill.number, /^(0[1-9]|1[0-5])$/);
    assert.ok(skill.label.trim(), `${skill.id} 缺中文名`);
    assert.ok(skill.labelEn.trim(), `${skill.id} 缺英文名`);
    assert.ok(skill.question.trim(), `${skill.id} 缺中文问题`);
    assert.ok(skill.questionEn.trim(), `${skill.id} 缺英文问题`);
    assert.ok(skill.grammar === "descriptive" || skill.grammar === "diagnostic");
    assert.ok(["narrative", "capability", "cash", "structure", "organization", "synthesis"].includes(skill.line));
    for (const level of ["a", "b", "c"]) {
      assert.ok(["runnable", "partial", "blocked"].includes(skill.evidence[level]));
    }
  }
});

test("每个技能都有提示词与五节输出", () => {
  for (const skill of COMPANY_SKILLS) {
    const entry = COMPANY_SKILL_PROMPTS[skill.id];
    assert.ok(entry, `${skill.id} 缺服务端提示词`);
    assert.ok(entry.prompt.length > 100, `${skill.id} 提示词过短`);
    assert.ok(entry.maxTokens >= 800 && entry.maxTokens <= 4000);
    assert.ok(entry.temperature >= 0 && entry.temperature <= 1);
    const built = buildCompanySystemPrompt(skill.id);
    for (const heading of ["## 判断", "## 依据", "## 点评", "## 反证", "## 底稿"]) {
      assert.ok(built.system.includes(heading), `${skill.id} 缺 ${heading}`);
    }
  }
});

test("按 id 查找，未知 id 返回 null", () => {
  assert.equal(findCompanySkill("four-causes")?.id, "four-causes");
  assert.equal(findCompanySkill("nope"), null);
  assert.equal(findCompanySkill(null), null);
});

test("系统提示包含共用规则与技能要点", () => {
  const prompt = buildCompanySystemPrompt("moat");
  assert.ok(prompt.system.startsWith(COMPANY_SKILL_RULES));
  assert.match(prompt.system, /利润池/);
  assert.match(prompt.system, /七种力量/);
});
