/**
 * 公司档案正文的结构化解析。
 *
 * 作者在 Notion 里按固定模板写正文，页面把它拆成「判断、事实、分节」三块渲染，
 * 读者看到的是结构化结论，方法论名称不出现在页面上。模板之外的正文照常显示，
 * 解析失败不会吞内容。
 */

export type CompanyVerdictKey = "bet" | "defense" | "death" | "falsifier";

export type CompanyAnalysisSection = {
  key: string;
  title: string;
  markdown: string;
};

export type ParsedCompanyAnalysis = {
  intro: string;
  verdict: Partial<Record<CompanyVerdictKey, string>>;
  verdictRaw: string;
  facts: string[];
  sections: CompanyAnalysisSection[];
  /** 至少识别出两个模板小节才算按模板写；否则整篇按普通正文渲染。 */
  hasTemplate: boolean;
};

const HEADING_ALIASES: Record<string, string> = {
  判断: "verdict",
  综合判断: "verdict",
  一句话判断: "verdict",
  结论: "verdict",
  基本事实: "facts",
  事实: "facts",
  事实底稿: "facts",
  公司事实: "facts",
  结构: "structure",
  结构与护城河: "structure",
  商业结构: "structure",
  能力: "capability",
  技术与交付: "capability",
  技术能力: "capability",
  现金: "cash",
  订单与现金: "cash",
  财务: "cash",
  现金流: "cash",
  组织: "organization",
  组织与文化: "organization",
  文化: "organization",
  市场: "market",
  市场与认知: "market",
  传播与市场: "market",
  关键问题: "question",
  待验证: "question",
  风险: "question",
};

const VERDICT_LABELS: Array<[CompanyVerdictKey, RegExp]> = [
  ["bet", /^(赌注|押注|下注)[：:]\s*(.+)$/],
  ["defense", /^(防守|护城河)[：:]\s*(.+)$/],
  ["death", /^(死法|失败方式|最可能的死法)[：:]\s*(.+)$/],
  ["falsifier", /^(反证条件|反证|改判信号)[：:]\s*(.+)$/],
];

function cleanInline(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s?/, "")
    .trim();
}

function canonicalKey(heading: string): string | null {
  const text = heading
    .replace(/\*\*/g, "")
    .replace(/[#`]/g, "")
    .replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "")
    .replace(/[：:]\s*$/, "")
    .replace(/\s+/g, "")
    .trim();
  return HEADING_ALIASES[text] ?? null;
}

function parseVerdict(markdown: string): {
  verdict: Partial<Record<CompanyVerdictKey, string>>;
  raw: string;
} {
  const verdict: Partial<Record<CompanyVerdictKey, string>> = {};
  const lines = markdown.split("\n");
  for (const line of lines) {
    const text = cleanInline(line);
    if (!text) continue;
    for (const [key, rx] of VERDICT_LABELS) {
      const match = text.match(rx);
      if (match) {
        verdict[key] = match[2].trim();
        break;
      }
    }
  }
  return { verdict, raw: markdown.trim() };
}

function parseFacts(markdown: string): string[] {
  const bullets = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*+]\s+/.test(line))
    .map((line) => cleanInline(line))
    .filter(Boolean);
  if (bullets.length) return bullets;
  return markdown
    .split("\n")
    .map((line) => cleanInline(line))
    .filter(Boolean);
}

/** 去掉正文开头与页面标题重复的一级标题。 */
function stripLeadingH1(text: string): string {
  return text.replace(/^\s*#\s+[^\n]+\n+/, "");
}

export function parseCompanyAnalysis(markdown: string): ParsedCompanyAnalysis {
  const source = stripLeadingH1((markdown || "").replace(/\r\n/g, "\n")).trim();
  if (!source) {
    return { intro: "", verdict: {}, verdictRaw: "", facts: [], sections: [], hasTemplate: false };
  }

  const headingRx = /^##[ \t]+(.+?)[ \t]*$/gm;
  const headings: Array<{ title: string; start: number; end: number }> = [];
  for (let match = headingRx.exec(source); match; match = headingRx.exec(source)) {
    headings.push({ title: match[1].trim(), start: match.index, end: match.index + match[0].length });
  }

  if (!headings.length) {
    return {
      intro: source,
      verdict: {},
      verdictRaw: "",
      facts: [],
      sections: [],
      hasTemplate: false,
    };
  }

  const intro = source.slice(0, headings[0].start).trim();
  const rawSections: CompanyAnalysisSection[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    const next = headings[i + 1];
    const body = source
      .slice(heading.end, next ? next.start : source.length)
      .trim();
    rawSections.push({
      key: canonicalKey(heading.title) ?? `other-${i}`,
      title: heading.title
        .replace(/\*\*/g, "")
        .replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "")
        .trim(),
      markdown: body,
    });
  }

  const verdictSection = rawSections.find((section) => section.key === "verdict");
  const factsSection = rawSections.find((section) => section.key === "facts");
  const parsedVerdict = verdictSection
    ? parseVerdict(verdictSection.markdown)
    : { verdict: {}, raw: "" };

  const sections = rawSections.filter(
    (section) => section.key !== "verdict" && section.key !== "facts" && section.markdown
  );

  return {
    intro,
    verdict: parsedVerdict.verdict,
    verdictRaw: parsedVerdict.raw,
    facts: factsSection ? parseFacts(factsSection.markdown) : [],
    sections,
    hasTemplate: rawSections.length >= 2 || Boolean(verdictSection) || Boolean(factsSection),
  };
}

export function hasVerdictGrid(
  verdict: Partial<Record<CompanyVerdictKey, string>>
): boolean {
  return Object.keys(verdict).length >= 2;
}
