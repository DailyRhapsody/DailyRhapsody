import { renderMarkdown } from "@/lib/markdown";
import { splitSkillCard } from "@/lib/company-skill-card-sections";

/**
 * 把模型返回的五节判断卡拆成可排版的块。
 *
 * 提示词要求固定五节，但模型偶尔会改标题或漏节；这里只做宽松解析，
 * 解析失败时整段回退到 markdown，不吞内容。
 */

export type SkillCard = {
  isStructured: boolean;
  insufficient: boolean;
  judgmentHtml: string;
  evidenceHtml: string;
  commentaryHtml: string;
  falsifierHtml: string;
  sourceHtml: string;
  rawHtml: string;
};

export function parseSkillCard(text: string): SkillCard {
  const source = (text ?? "").replace(/\r\n/g, "\n").trim();
  const parsed = splitSkillCard(source);
  const { sections } = parsed;

  return {
    isStructured: parsed.isStructured,
    insufficient: parsed.insufficient,
    judgmentHtml: sections.judgment ? renderMarkdown(sections.judgment) : "",
    evidenceHtml: sections.evidence ? renderMarkdown(sections.evidence) : "",
    commentaryHtml: sections.commentary ? renderMarkdown(sections.commentary) : "",
    falsifierHtml: sections.falsifier ? renderMarkdown(sections.falsifier) : "",
    sourceHtml: sections.source ? renderMarkdown(sections.source) : "",
    rawHtml: renderMarkdown(source),
  };
}
