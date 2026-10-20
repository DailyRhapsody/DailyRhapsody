// 公司档案正文解析：模板识别、判断四行、事实与未知小节兜底。
import assert from "node:assert/strict";
import { test } from "node:test";

const { parseCompanyAnalysis, hasVerdictGrid } = await import("../lib/company-analysis.ts");

const TEMPLATE = `# 某某机器人

## 判断
- **赌注**：仓储场景的人工替代。
- 防守：客户现场的工艺数据。
死法: 项目制交付拖垮现金流。
反证条件：出现标准品批量复购。

## 基本事实
- 主体：某某智能科技有限公司
- 成立：2024-03
- 团队：参保 42 人

## 结构
利润池在下游集成，本体毛利受集成商挤压。

## 能力
样机已进入小批量，量产未验证。

## 关键问题
- 复购是否真实
`;

test("按模板解析出判断、事实与分节", () => {
  const parsed = parseCompanyAnalysis(TEMPLATE);
  assert.equal(parsed.hasTemplate, true);
  assert.equal(parsed.intro, "");
  assert.equal(parsed.verdict.bet, "仓储场景的人工替代。");
  assert.equal(parsed.verdict.defense, "客户现场的工艺数据。");
  assert.equal(parsed.verdict.death, "项目制交付拖垮现金流。");
  assert.equal(parsed.verdict.falsifier, "出现标准品批量复购。");
  assert.deepEqual(parsed.facts, [
    "主体：某某智能科技有限公司",
    "成立：2024-03",
    "团队：参保 42 人",
  ]);
  assert.deepEqual(
    parsed.sections.map((s) => s.key),
    ["structure", "capability", "question"]
  );
  assert.equal(hasVerdictGrid(parsed.verdict), true);
});

test("没有二级标题时整篇按正文返回", () => {
  const parsed = parseCompanyAnalysis("# 标题\n\n这是一段普通正文，没有小节。");
  assert.equal(parsed.hasTemplate, false);
  assert.equal(parsed.intro, "这是一段普通正文，没有小节。");
  assert.deepEqual(parsed.sections, []);
});

test("未知小节保留，不吞内容", () => {
  const parsed = parseCompanyAnalysis("## 判断\n赌注：A\n防守：B\n\n## 供应链\n关键件单一来源。");
  assert.equal(parsed.hasTemplate, true);
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].key, "other-1");
  assert.equal(parsed.sections[0].title, "供应链");
  assert.match(parsed.sections[0].markdown, /单一来源/);
});

test("判断只有一行时不给四宫格", () => {
  const parsed = parseCompanyAnalysis("## 判断\n赌注：只有一个判断。\n\n## 结构\n正文。");
  assert.equal(hasVerdictGrid(parsed.verdict), false);
  assert.equal(parsed.verdict.bet, "只有一个判断。");
});

test("空正文不抛错", () => {
  const parsed = parseCompanyAnalysis("");
  assert.equal(parsed.hasTemplate, false);
  assert.equal(parsed.intro, "");
  assert.deepEqual(parsed.facts, []);
});

test("既有档案的编号标题去掉编号后按分节渲染", () => {
  const parsed = parseCompanyAnalysis("## 1. 一句话定位\n正文一。\n\n## 2. 公司与创始人\n正文二。");
  assert.equal(parsed.hasTemplate, true);
  assert.deepEqual(
    parsed.sections.map((s) => s.title),
    ["一句话定位", "公司与创始人"]
  );
});
