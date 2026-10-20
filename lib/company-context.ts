import type { ReferenceItem } from "@/lib/notion-reference";

const MAX_CONTEXT_CHARS = 14_000;

/**
 * 把公司档案压成模型可读的材料。
 *
 * 档案里的通稿口径要保留原样，不替模型“修正”成确定事实；提示词已要求区分
 * 已证实、推断与未披露，这里只负责按来源分层并限长。
 */
export function buildCompanyContext(item: ReferenceItem): string {
  const profile = item.company;
  const lines: string[] = [];
  lines.push(`【公司】${item.titleZh?.trim() || item.name}`);
  if (item.summary) lines.push(`【一句话】${item.summary}`);

  const tags = [
    ...(item.domains ?? []),
    ...(item.robotTypes ?? []),
    ...(item.tags ?? []),
    ...(profile?.companyTags ?? []),
  ].filter(Boolean);
  if (tags.length) lines.push(`【标签】${Array.from(new Set(tags)).join("、")}`);

  if (profile) {
    const facts: string[] = [];
    if (profile.headcount != null) facts.push(`人数：${profile.headcount}`);
    if (profile.productForms.length) facts.push(`产品形态：${profile.productForms.join("、")}`);
    if (profile.scenarios.length) facts.push(`场景：${profile.scenarios.join("、")}`);
    if (profile.markets.length) facts.push(`市场：${profile.markets.join("、")}`);
    if (profile.salesModes.length) facts.push(`售卖方式：${profile.salesModes.join("、")}`);
    if (profile.listed) facts.push(`上市：${profile.listed}`);
    if (profile.profitability) facts.push(`盈亏：${profile.profitability}`);
    if (profile.operationCulture) facts.push(`运营文化：${profile.operationCulture}`);
    if (facts.length) lines.push(`【档案字段】\n${facts.map((f) => `- ${f}`).join("\n")}`);
  }

  const body = (item.bodyMarkdown ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CONTEXT_CHARS);
  lines.push(`【档案正文】\n${body || "（正文尚未补全，只能依据档案字段判断）"}`);
  lines.push("【说明】以上材料可能混有融资通稿与公司自述；判断时区分已证实、推断与未披露。");
  return lines.join("\n\n");
}
