/**
 * 判断卡五节的纯解析，不依赖 markdown 渲染，便于单元测试。
 */

export type SkillSectionKey = "judgment" | "evidence" | "commentary" | "falsifier" | "source";

export type SkillCardSections = {
  sections: Partial<Record<SkillSectionKey, string>>;
  judgmentText: string;
  isStructured: boolean;
  insufficient: boolean;
};

const HEADINGS: Record<string, SkillSectionKey> = {
  判断: "judgment",
  结论: "judgment",
  judgment: "judgment",
  judgement: "judgment",
  verdict: "judgment",
  依据: "evidence",
  证据: "evidence",
  evidence: "evidence",
  点评: "commentary",
  评论: "commentary",
  commentary: "commentary",
  反证: "falsifier",
  反证条件: "falsifier",
  falsifier: "falsifier",
  "counter-evidence": "falsifier",
  counterevidence: "falsifier",
  "counter evidence": "falsifier",
  "disconfirming evidence": "falsifier",
  falsification: "falsifier",
  底稿: "source",
  附注: "source",
  source: "source",
  notes: "source",
  "working paper": "source",
  "working notes": "source",
  appendix: "source",
};

const HEADING_RE = /^##\s*(.+?)\s*$/gm;

function stripMarkdown(text: string): string {
  return text
    .replace(/[*_`#>~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSkillCard(text: string): SkillCardSections {
  const source = (text ?? "").replace(/\r\n/g, "\n").trim();
  const sections: Partial<Record<SkillSectionKey, string>> = {};

  const matches = Array.from(source.matchAll(HEADING_RE));
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const title = (match[1] ?? "").trim().toLowerCase();
    const key = HEADINGS[title];
    if (!key) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? source.length : source.length;
    const body = source.slice(start, end).trim();
    if (body) sections[key] = body;
  }

  const judgmentText = stripMarkdown(sections.judgment ?? "");
  const structuredCount = Object.keys(sections).length;

  return {
    sections,
    judgmentText,
    isStructured: Boolean(judgmentText) && structuredCount >= 2,
    insufficient: /^(证据不足|insufficient evidence)/i.test(judgmentText),
  };
}
