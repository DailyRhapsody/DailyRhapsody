// 判断卡五节解析的守卫：正常五节、证据不足、缺节回退。
import assert from "node:assert/strict";
import { test } from "node:test";

const { splitSkillCard } = await import("../lib/company-skill-card-sections.ts");

const SAMPLE = `## 判断
搬马是成熟底盘上的产品线延伸，客户验收 KPI 的公开证据不足。

## 依据
- 形式因：年报披露九大类、上百款产品（A，2026-04-21，2025 年报）。
- 目的因：客户工序的验收项未披露（C，2026-04-21）。

## 点评
四因在成本、渠道与快递场景上对齐。最脆弱的是目的因，公开证据停在客户案例与奖项。

## 反证
公开渠道（客户验收公告、第三方测试报告）在 12 个月内出现吞吐与 uptime 达标记录，则本判断作废。

## 底稿
| 因 | 承载者 | 等级 |
| --- | --- | --- |
| 质料 | 成熟底盘 | B/C |`;

test("拆出五节并识别结构化", () => {
  const card = splitSkillCard(SAMPLE);
  assert.equal(card.isStructured, true);
  assert.equal(card.insufficient, false);
  assert.match(card.sections.judgment ?? "", /产品线延伸/);
  assert.match(card.sections.evidence ?? "", /形式因/);
  assert.match(card.sections.commentary ?? "", /最脆弱/);
  assert.match(card.sections.falsifier ?? "", /12 个月/);
  assert.match(card.sections.source ?? "", /质料/);
});

test("识别证据不足", () => {
  const card = splitSkillCard(`## 判断
证据不足：档案没有验收记录。

## 依据
缺少客户验收公告与工单。`);
  assert.equal(card.isStructured, true);
  assert.equal(card.insufficient, true);
});

test("识别三项判断中的单项证据不足", () => {
  const card = splitSkillCard(`## 判断
主导层：证据不足：没有政策文件。
公司：证据不足：没有收入拆分。
目的：家族传承优先。
位置：证据不足：没有授权记录。

## 依据
权力与目的缺少董事会与预算记录。`);
  assert.equal(card.isStructured, true);
  assert.equal(card.insufficient, true);
});

test("识别英文标题变体", () => {
  const card = splitSkillCard(`## Judgement
The final cause is only partly disclosed.

## Evidence
- Customer names are public; acceptance metrics are not.

## Commentary
The weakest link is the final cause.

## Counter-evidence
A named customer disclosing acceptance metrics would overturn this.

## Working paper
| Cause | Carrier |
| --- | --- |
| Final | Customer workflow |`);
  assert.equal(card.isStructured, true);
  assert.equal(card.insufficient, false);
  assert.match(card.sections.judgment ?? "", /final cause/);
  assert.match(card.sections.falsifier ?? "", /overturn/);
  assert.match(card.sections.source ?? "", /Customer workflow/);
});

test("缺标题时回退为非结构化", () => {
  const card = splitSkillCard("这是一段没有五节标题的分析。");
  assert.equal(card.isStructured, false);
  assert.equal(card.judgmentText, "");
});
