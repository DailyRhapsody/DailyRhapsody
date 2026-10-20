/**
 * 公司分析技能的客户端目录。
 *
 * 这里只放卡片要用的纯数据，提示词在 lib/company-skill-prompts.ts，只有服务端能加载。
 * 客户端组件只 import 这个文件，提示词不会进浏览器产物。
 *
 * id 属于协议字段：改名会让缓存键与已存结果对不上号。要改对外称呼就改 label。
 */

export const COMPANY_SKILL_PROMPT_VERSION = "2026-10-21.2";

export type CompanySkillId =
  | "terms"
  | "promise"
  | "trl"
  | "four-causes"
  | "concretization"
  | "breakdown"
  | "research-programme"
  | "critical-parts"
  | "orders-cash"
  | "metrics"
  | "translation"
  | "moat"
  | "field"
  | "chaxu"
  | "main-conflict";

export type SkillGrammar = "descriptive" | "diagnostic";
export type SkillLine = "narrative" | "capability" | "cash" | "structure" | "organization" | "synthesis";
export type EvidenceLevel = "a" | "b" | "c";
export type EvidenceState = "runnable" | "partial" | "blocked";

export type CompanySkillMeta = {
  id: CompanySkillId;
  number: string;
  label: string;
  labelEn: string;
  question: string;
  questionEn: string;
  grammar: SkillGrammar;
  line: SkillLine;
  evidence: Record<EvidenceLevel, EvidenceState>;
  progress: string;
  progressEn: string;
};

export const COMPANY_SKILLS: readonly CompanySkillMeta[] = [
  {
    id: "terms",
    number: "01",
    label: "术语与归类",
    labelEn: "Terms and categories",
    question: "公司用来定义自己的词，在招股书、官网、招聘与招标里是否指同一件事。",
    questionEn: "Do the words a company uses to define itself mean the same thing across filings, site, hiring and tenders?",
    grammar: "descriptive",
    line: "narrative",
    evidence: { a: "runnable", b: "runnable", c: "runnable" },
    progress: "正在核对术语的使用痕迹",
    progressEn: "Tracing how the terms are actually used",
  },
  {
    id: "promise",
    number: "02",
    label: "承诺与交付",
    labelEn: "Promises and delivery",
    question: "公开承诺之后，预算、编制、考核与交付有没有跟上。",
    questionEn: "After a public promise, did budget, headcount, incentives and delivery follow?",
    grammar: "diagnostic",
    line: "narrative",
    evidence: { a: "runnable", b: "runnable", c: "partial" },
    progress: "正在对照承诺与资源",
    progressEn: "Comparing promises with resources",
  },
  {
    id: "trl",
    number: "03",
    label: "技术成熟度",
    labelEn: "Technology readiness",
    question: "核心技术处在 TRL 第几级，宣称级别与证据级别差几级。",
    questionEn: "What TRL level does the core technology actually reach, and how far is the claim from the evidence?",
    grammar: "diagnostic",
    line: "capability",
    evidence: { a: "runnable", b: "runnable", c: "runnable" },
    progress: "正在给技术定级",
    progressEn: "Rating the evidence level",
  },
  {
    id: "four-causes",
    number: "04",
    label: "四因核对",
    labelEn: "Four causes",
    question: "对一个已交付型号，质料、形式、动力、目的四因各由谁承载。",
    questionEn: "For a delivered model, who carries the material, formal, efficient and final causes?",
    grammar: "descriptive",
    line: "capability",
    evidence: { a: "runnable", b: "runnable", c: "runnable" },
    progress: "正在拆解四因归属",
    progressEn: "Mapping the four causes",
  },
  {
    id: "concretization",
    number: "05",
    label: "技术物具体化",
    labelEn: "Concretization",
    question: "这台机器是部件一功能一对应的拼装，还是部件多职能、彼此配合的整合。",
    questionEn: "Is the machine a one-part-one-function assembly, or an integration where parts carry several functions?",
    grammar: "descriptive",
    line: "capability",
    evidence: { a: "runnable", b: "partial", c: "partial" },
    progress: "正在看结构与代际变化",
    progressEn: "Reading structure and generational change",
  },
  {
    id: "breakdown",
    number: "06",
    label: "故障与依赖",
    labelEn: "Breakdown and dependence",
    question: "产品在故障、缺失、挡路时暴露出哪些依赖，每台设备需要多少人力与配套。",
    questionEn: "What dependencies appear when the product breaks, is missing or blocks the way, and how much labor does each unit need?",
    grammar: "diagnostic",
    line: "capability",
    evidence: { a: "runnable", b: "partial", c: "runnable" },
    progress: "正在还原依赖网络",
    progressEn: "Reconstructing the dependency network",
  },
  {
    id: "research-programme",
    number: "07",
    label: "研究纲领",
    labelEn: "Research programme",
    question: "硬核是什么，保护带换过什么，最近的调整预言了新事实还是只解释失败。",
    questionEn: "What is the hard core, what has the protective belt changed, and did the latest adjustment predict anything new?",
    grammar: "diagnostic",
    line: "capability",
    evidence: { a: "runnable", b: "partial", c: "partial" },
    progress: "正在读路线与代际",
    progressEn: "Reading the route and generations",
  },
  {
    id: "critical-parts",
    number: "08",
    label: "关键件依赖",
    labelEn: "Critical parts",
    question: "哪个部件卡住成本、产能或合规，断供后多久能换掉。",
    questionEn: "Which part constrains cost, capacity or compliance, and how long would replacement take?",
    grammar: "diagnostic",
    line: "capability",
    evidence: { a: "runnable", b: "partial", c: "blocked" },
    progress: "正在找关键件与替代周期",
    progressEn: "Finding critical parts and replacement lead time",
  },
  {
    id: "orders-cash",
    number: "09",
    label: "订单与回款",
    labelEn: "Orders and cash",
    question: "谁付钱、付多少、是否复购，收入有没有变成现金。",
    questionEn: "Who pays, how much, do they repeat, and does revenue turn into cash?",
    grammar: "diagnostic",
    line: "cash",
    evidence: { a: "runnable", b: "partial", c: "runnable" },
    progress: "正在核对订单与现金",
    progressEn: "Checking orders and cash",
  },
  {
    id: "metrics",
    number: "10",
    label: "参数与口径",
    labelEn: "Specs and measures",
    question: "规格书、演示与榜单里的参数，在招标、验收与工单中兑现了多少。",
    questionEn: "How much of the spec sheet, demo and ranking survives tender, acceptance and work orders?",
    grammar: "diagnostic",
    line: "cash",
    evidence: { a: "runnable", b: "partial", c: "runnable" },
    progress: "正在对齐四处口径",
    progressEn: "Aligning the four sources",
  },
  {
    id: "translation",
    number: "11",
    label: "转译与必经点",
    labelEn: "Translation and passage points",
    question: "需求从客户到回款经过谁，每个行动者把它改写成了什么，谁卡住必经点。",
    questionEn: "Who does the demand pass through from customer to cash, how is it rewritten, and who controls the passage point?",
    grammar: "descriptive",
    line: "cash",
    evidence: { a: "runnable", b: "runnable", c: "runnable" },
    progress: "正在追需求转译链",
    progressEn: "Tracing the translation chain",
  },
  {
    id: "moat",
    number: "12",
    label: "护城河与利润池",
    labelEn: "Moat and profit pool",
    question: "利润集中在产业链哪一段，它靠哪一种力量不被替代。",
    questionEn: "Where does profit concentrate in the chain, and which power keeps it from being replaced?",
    grammar: "diagnostic",
    line: "structure",
    evidence: { a: "runnable", b: "partial", c: "partial" },
    progress: "正在画利润池与七种力量",
    progressEn: "Mapping the profit pool and seven powers",
  },
  {
    id: "field",
    number: "13",
    label: "场域与资本",
    labelEn: "Field and capital",
    question: "这个场域比的是什么，各种资本如何兑换为订单，哪种资本被误认为技术。",
    questionEn: "What is being contested in this field, how does each capital convert into orders, and which capital is misread as technology?",
    grammar: "diagnostic",
    line: "structure",
    evidence: { a: "runnable", b: "runnable", c: "runnable" },
    progress: "正在划场域与兑换事件",
    progressEn: "Mapping the field and conversion events",
  },
  {
    id: "chaxu",
    number: "14",
    label: "差序格局",
    labelEn: "Relational structure",
    question: "关键决策与资源沿正式职权流动，还是沿以某人为中心的圈层流动。",
    questionEn: "Do key decisions and resources flow through formal authority or through person-centered circles?",
    grammar: "descriptive",
    line: "organization",
    evidence: { a: "runnable", b: "partial", c: "partial" },
    progress: "正在看治理记录",
    progressEn: "Reading governance records",
  },
  {
    id: "main-conflict",
    number: "15",
    label: "主要冲突",
    labelEn: "Principal conflict",
    question: "哪一个冲突不解决，其余问题就无法缓解。",
    questionEn: "Which conflict, left unresolved, keeps every other problem in place?",
    grammar: "diagnostic",
    line: "synthesis",
    evidence: { a: "runnable", b: "runnable", c: "runnable" },
    progress: "正在收束主要冲突",
    progressEn: "Narrowing to the principal conflict",
  },
];

const BY_ID = new Map<string, CompanySkillMeta>(COMPANY_SKILLS.map((skill) => [skill.id, skill]));

export function findCompanySkill(id: unknown): CompanySkillMeta | null {
  return typeof id === "string" ? BY_ID.get(id) ?? null : null;
}

export function companySkillLabel(skill: CompanySkillMeta, lang: "zh" | "en"): string {
  return lang === "en" ? skill.labelEn : skill.label;
}

export function companySkillHint(skill: CompanySkillMeta, lang: "zh" | "en"): string {
  return lang === "en" ? skill.questionEn : skill.question;
}

export function companySkillGrammar(skill: CompanySkillMeta, lang: "zh" | "en"): string {
  if (lang === "en") return skill.grammar === "descriptive" ? "Descriptive" : "Diagnostic";
  return skill.grammar === "descriptive" ? "描述" : "诊断";
}

export function companySkillLine(skill: CompanySkillMeta, lang: "zh" | "en"): string {
  const lines: Record<SkillLine, [string, string]> = {
    narrative: ["叙事", "Narrative"],
    capability: ["能力", "Capability"],
    cash: ["现金流", "Cash"],
    structure: ["结构", "Structure"],
    organization: ["组织", "Organization"],
    synthesis: ["收束", "Synthesis"],
  };
  return lines[skill.line][lang === "en" ? 1 : 0];
}

export function companySkillEvidence(
  skill: CompanySkillMeta,
  level: EvidenceLevel,
  lang: "zh" | "en"
): string {
  const state = skill.evidence[level];
  const labels: Record<EvidenceState, [string, string]> = {
    runnable: ["可跑", "Runnable"],
    partial: ["部分", "Partial"],
    blocked: ["不可跑", "Blocked"],
  };
  const prefix = level.toUpperCase();
  return `${prefix} ${labels[state][lang === "en" ? 1 : 0]}`;
}

/**
 * 卡片正面要显示「哪位名人 / 哪套方法论」，与 flomo 的大师视角一致。
 * 放在单独的表里，避免十五条目录对象各加四个字段后难读。
 */
const MASTER_METHOD: Record<
  CompanySkillId,
  { master: string; masterEn: string; method: string; methodEn: string }
> = {
  terms: {
    master: "维特根斯坦",
    masterEn: "Wittgenstein",
    method: "家族相似",
    methodEn: "Family resemblance",
  },
  promise: {
    master: "奥斯汀 / 塞尔",
    masterEn: "Austin / Searle",
    method: "言语行为",
    methodEn: "Speech acts",
  },
  trl: {
    master: "Mankins / NASA",
    masterEn: "Mankins / NASA",
    method: "技术就绪水平",
    methodEn: "Technology readiness",
  },
  "four-causes": {
    master: "亚里士多德",
    masterEn: "Aristotle",
    method: "四因说",
    methodEn: "Four causes",
  },
  concretization: {
    master: "西蒙东",
    masterEn: "Simondon",
    method: "技术物具体化",
    methodEn: "Concretization",
  },
  breakdown: {
    master: "海德格尔",
    masterEn: "Heidegger",
    method: "上手与在手",
    methodEn: "Ready-to-hand and present-at-hand",
  },
  "research-programme": {
    master: "拉卡托斯",
    masterEn: "Lakatos",
    method: "研究纲领",
    methodEn: "Research programme",
  },
  "critical-parts": {
    master: "Kraljic",
    masterEn: "Kraljic",
    method: "采购组合",
    methodEn: "Purchasing portfolio",
  },
  "orders-cash": {
    master: "会计学",
    masterEn: "Accounting",
    method: "收入确认与现金周期",
    methodEn: "Revenue recognition and cash cycle",
  },
  metrics: {
    master: "Campbell",
    masterEn: "Campbell",
    method: "坎贝尔定律",
    methodEn: "Campbell's law",
  },
  translation: {
    master: "拉图尔 / 卡龙",
    masterEn: "Latour / Callon",
    method: "转译社会学",
    methodEn: "Sociology of translation",
  },
  moat: {
    master: "Helmer",
    masterEn: "Helmer",
    method: "七种力量",
    methodEn: "Seven powers",
  },
  field: {
    master: "布迪厄",
    masterEn: "Bourdieu",
    method: "场域与资本",
    methodEn: "Field and capital",
  },
  chaxu: {
    master: "费孝通",
    masterEn: "Fei Xiaotong",
    method: "差序格局",
    methodEn: "Differential mode of association",
  },
  "main-conflict": {
    master: "毛泽东",
    masterEn: "Mao Zedong",
    method: "矛盾论",
    methodEn: "On contradiction",
  },
};

export function companySkillMaster(skill: CompanySkillMeta, lang: "zh" | "en"): string {
  return lang === "en" ? MASTER_METHOD[skill.id].masterEn : MASTER_METHOD[skill.id].master;
}

export function companySkillMethod(skill: CompanySkillMeta, lang: "zh" | "en"): string {
  return lang === "en" ? MASTER_METHOD[skill.id].methodEn : MASTER_METHOD[skill.id].method;
}
