// 全站语言判定与文案字典。
//
// 2026-10：英文样式暂时关闭，服务端 getLang() 固定返回 zh；下面的英文文案与
// cookie/Accept-Language 逻辑保留，恢复时把 i18n-server.ts 的 EN_ENABLED 改回 true。
// 作者姓名、签名、博客正文不翻译。

export type Lang = "zh" | "en";

export const LANG_COOKIE = "dr_lang";
export const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en";
}

/** 只认明确的中英文，其余语言先回落到中文（站点主体是中文内容）。 */
export function detectLangFromAcceptLanguage(header: string | null | undefined): Lang {
  if (!header) return "zh";
  const first = header.split(",")[0]?.trim().toLowerCase() ?? "";
  if (first.startsWith("zh")) return "zh";
  if (first.startsWith("en")) return "en";
  return "zh";
}

const messages: Record<string, { zh: string; en: string }> = {
  // 通用动作
  "common.cancel": { zh: "取消", en: "Cancel" },
  "common.clear": { zh: "清空", en: "Clear" },
  "common.retry": { zh: "重试", en: "Retry" },
  "common.loading": { zh: "加载中", en: "Loading" },
  "common.close": { zh: "关闭", en: "Close" },

  // Reference 列表
  "reference.title": { zh: "Reference · 机器人行业资料库", en: "Reference · Robotics research library" },
  "reference.meta.description": {
    zh: "机器人领域的行业资料、竞品调研、实测报告与访谈，按类型、领域与机构归档，供同行检索与引用。",
    en: "Robotics industry research, competitive analyses, hands-on reports, and interviews, organized by type, domain, and organization.",
  },
  "reference.search.placeholder": {
    zh: "搜索标题、摘要、来源、标签或公司",
    en: "Search titles, summaries, sources, tags, or companies",
  },
  "reference.search.label": { zh: "搜索资料", en: "Search references" },
  "reference.search.clear": { zh: "清空搜索", en: "Clear search" },
  "reference.list.heading": { zh: "资料列表", en: "Reference list" },
  "reference.list.loading": { zh: "资料加载中", en: "Loading references" },
  "reference.sort.label": { zh: "排序", en: "Sort" },
  "reference.sort.primary": { zh: "主排序字段", en: "Primary sort field" },
  "reference.sort.secondary": { zh: "次级排序字段", en: "Secondary sort field" },
  "reference.sort.direction": { zh: "排序方向", en: "Sort direction" },
  "reference.sort.empty": { zh: "还没有排序条件", en: "No sorts yet" },
  "reference.sort.add": { zh: "添加排序", en: "Add sort" },
  "reference.sort.remove": { zh: "删除排序", en: "Delete sort" },
  "reference.sort.removeRule": { zh: "删除这条排序", en: "Remove this sort" },
  // 方向按字段类型说人话：日期「新→旧」、年份「高→低」、文本「A→Z」。
  "reference.sort.dir.date.desc": { zh: "按“新 → 旧”排序", en: "Newest first" },
  "reference.sort.dir.date.asc": { zh: "按“旧 → 新”排序", en: "Oldest first" },
  "reference.sort.dir.number.desc": { zh: "按“高 → 低”排序", en: "High to low" },
  "reference.sort.dir.number.asc": { zh: "按“低 → 高”排序", en: "Low to high" },
  "reference.sort.dir.text.asc": { zh: "按“A → Z”排序", en: "A to Z" },
  "reference.sort.dir.text.desc": { zh: "按“Z → A”排序", en: "Z to A" },
  "reference.empty.noItems": {
    zh: "暂无资料。等作者从 Notion 添加入库后，这里会自动出现。",
    en: "No references yet. New items from Notion will appear here automatically.",
  },
  "reference.empty.noMatch": {
    zh: "没有符合当前搜索与筛选条件的资料。",
    en: "No references match the current search and filters.",
  },
  "reference.empty.noFilterMatch": { zh: "没有符合当前条件的资料。", en: "No references match these filters." },
  "reference.loadingMore": { zh: "加载中", en: "Loading" },
  "reference.selected.label": { zh: "已选中：", en: "Selected: " },
  "reference.selected.missing": { zh: "该资料不在当前列表", en: "not in the current list" },
  "reference.selected.clear": { zh: "取消选中", en: "Clear selection" },
  "reference.tag.current": { zh: "当前标签：{tag}（共 {total} 条）", en: "Tag: {tag} · {total} items" },
  "reference.updating": { zh: "更新中…", en: "Updating…" },

  // Reference 卡片
  "reference.card.read": { zh: "阅读", en: "Read" },
  "reference.card.readFull": { zh: "阅读全文", en: "Read more" },
  "reference.card.like": { zh: "点赞", en: "Like" },
  "reference.card.unlike": { zh: "取消点赞", en: "Unlike" },
  "reference.card.likeAria": { zh: "点赞，当前 {n} 人觉得有用", en: "Like · {n} people found this useful" },
  "reference.card.unlikeAria": { zh: "取消点赞，当前 {n} 人觉得有用", en: "Unlike · {n} people found this useful" },
  "reference.card.untitled": { zh: "(无标题)", en: "(Untitled)" },
  "reference.card.scenarios": { zh: "场景", en: "Use cases" },
  "reference.card.products": { zh: "产品", en: "Products" },
  "reference.card.culture": { zh: "文化", en: "Culture" },
  "reference.card.domain": { zh: "领域", en: "Domain" },
  "reference.card.robotType": { zh: "类型", en: "Type" },

  // Reference 详情
  "reference.detail.back": { zh: "返回资料", en: "Back to references" },
  "reference.detail.jump": { zh: "跳到原文", en: "Open source" },
  "reference.detail.jumpRead": { zh: "跳到原文阅读", en: "Read at the source" },
  "reference.detail.kind": { zh: "类型", en: "Type" },
  "reference.detail.collected": { zh: "收集于", en: "Collected" },
  "reference.detail.download": { zh: "下载附件", en: "Download attachment" },
  "reference.detail.listHeading": { zh: "资料列表", en: "Reference list" },
  "reference.detail.year": { zh: "年份", en: "Year" },
  "reference.detail.domains": { zh: "领域", en: "Domains" },
  "reference.detail.source": { zh: "来源", en: "Source" },
  "reference.detail.sourceUnknown": { zh: "外部来源", en: "External source" },
  "reference.detail.rights": { zh: "版权归原作者", en: "Copyright belongs to the original author" },
  "reference.detail.original": { zh: "原文", en: "Source" },
  "reference.detail.pdfNote": {
    zh: "PDF 会在浏览器中打开，可用浏览器自带的下载按钮另存。版权见下方说明。",
    en: "The PDF opens in your browser; use the browser's download button to save it. See the rights note below.",
  },
  "reference.detail.emptyBody": {
    zh: "这条资料没有正文，直接去原文阅读。",
    en: "This entry has no body text. Read it at the source.",
  },
  "reference.detail.useful": { zh: "有用", en: "Useful" },
  "reference.detail.share": { zh: "分享", en: "Share" },
  "reference.detail.copied": { zh: "已复制", en: "Copied" },
  "reference.detail.copyPrompt": { zh: "复制链接分享：", en: "Copy this link: " },

  // 公司档案
  "company.heading": { zh: "公司档案", en: "Company profile" },
  "company.name": { zh: "公司名称", en: "Company" },
  "company.headcount": { zh: "业务人数", en: "Headcount" },
  "company.scenarios": { zh: "场景定位", en: "Use cases" },
  "company.products": { zh: "产品形态", en: "Products" },
  "company.culture": { zh: "运营文化", en: "Culture" },
  "company.markets": { zh: "市场位置", en: "Markets" },
  "company.tags": { zh: "公司标签", en: "Tags" },
  "company.sales": { zh: "售卖形态", en: "Sales" },
  "company.listed": { zh: "是否上市", en: "Listed" },
  "company.profitability": { zh: "业务盈亏", en: "P&L" },
  "company.interview": { zh: "是否通过面试", en: "Interview" },
  "company.analysis.title": { zh: "哲学之剑", en: "Philosophy sword" },
  "company.analysis.note": {
    zh: "整体判断与主轴 · 草稿",
    en: "Overall judgment and main axis · draft",
  },
  "company.analysis.empty": {
    zh: "这份档案还没有正文。",
    en: "This dossier has no body yet.",
  },
  "company.analysis.toc": { zh: "目录", en: "Contents" },
  "company.verdict.title": { zh: "判断", en: "Judgment" },
  "company.tabs.label": { zh: "公司档案分段", en: "Company sections" },
  "company.tabs.intro": { zh: "简介", en: "Intro" },
  "company.tabs.philosophy": { zh: "哲学之剑", en: "Philosophy sword" },
  "company.tabs.master": { zh: "大师之剑", en: "Master sword" },
  "company.tabs.author": { zh: "作者之剑", en: "Author's sword" },
  "company.philosophy.placeholder": {
    zh: "融合主轴尚未定义。这里将放：一句话定性、三线状态、三项判定与反证条件。",
    en: "The fused main axis is not defined yet. This slot will hold the one-line verdict, three-line status, three judgments and falsifiers.",
  },
  "company.philosophy.reserved": {
    zh: "预留位 · 不参与当前分析",
    en: "Reserved · not part of the current analysis",
  },
  "company.facts.title": { zh: "基本事实", en: "Key facts" },
  "company.verdict.bet": { zh: "赌注", en: "Bet" },
  "company.verdict.defense": { zh: "防守", en: "Defense" },
  "company.verdict.death": { zh: "死法", en: "Failure mode" },
  "company.verdict.falsifier": { zh: "反证条件", en: "Falsifier" },
  "company.master.title": { zh: "大师之剑", en: "Master sword" },
  "company.master.note": {
    zh: "十五张技能卡，点击后分析当前公司；全部为试用版。",
    en: "Fifteen skill cards. Click one to analyze this company; all are trial versions.",
  },
  "company.master.legend": {
    zh: "证据条件：甲 上市或 IPO · 乙 未上市融资 · 丙 项目制集成商；绿点可跑、黄点部分、灰点不可跑。",
    en: "Evidence: A listed/IPO · B funded private · C project integrator; green runnable, amber partial, grey blocked.",
  },
  "company.skills.title": { zh: "用技能分析", en: "Analyze with a skill" },
  "company.skills.note": {
    zh: "由大模型基于本页档案生成，结论可能出错",
    en: "Generated from this dossier by an LLM; may be wrong",
  },
  "company.skills.empty": {
    zh: "选一张卡，生成当前公司的判断",
    en: "Pick a card to generate a judgment for this company",
  },
  "company.skills.error": {
    zh: "分析失败，请稍后重试。",
    en: "Analysis failed. Try again later.",
  },
  "company.skills.cached": { zh: "已缓存", en: "Cached" },
  "company.skills.rerun": { zh: "重新生成", en: "Regenerate" },
  "company.skills.close": { zh: "收起", en: "Collapse" },
  "company.skills.evidence": { zh: "依据", en: "Evidence" },
  "company.skills.commentary": { zh: "点评", en: "Commentary" },
  "company.skills.falsifier": { zh: "反证", en: "Falsifier" },
  "company.skills.source": { zh: "底稿", en: "Working notes" },
  "company.skills.generated": { zh: "已生成", en: "Generated" },
  "company.skills.analyze": { zh: "点击分析 →", en: "Analyze →" },
  "company.skills.running": { zh: "分析中…", en: "Analyzing…" },
  "company.skills.insufficient": { zh: "证据不足", en: "Insufficient evidence" },
  "company.author.title": { zh: "作者之剑", en: "Author's sword" },
  "company.author.intro": {
    zh: "用滕君公开人设中的判断顺序，先看所有权、实权与目的函数，再把公司、目的、位置分开判；最后看十年尺度、证据与叙事差额。只使用公开材料与公开人设，不读取私密记忆。",
    en: "Uses Teng Jun's public judgment order: ownership, real power and purpose first; then judges the company, the purpose and the position separately; finally the ten-year view, evidence and the gap between narrative and reality. Public material and the public persona only; no private memory.",
  },
  "company.author.cta": { zh: "生成作者判断", en: "Generate author's judgment" },
  "company.author.judgment": { zh: "作者判断", en: "Author's judgment" },
  "company.author.disclaimer": {
    zh: "AI 依据公开人设生成的推断，不代表滕君此刻的观点。",
    en: "An AI inference from the public persona; not Teng Jun's current view.",
  },
  "company.author.method.title": { zh: "判断顺序", en: "Judgment order" },
  "company.author.method.note": {
    zh: "先看所有权、实权与目的函数，再看它们如何通过预算、人事与资源分配塑造产品、技术与十年；公司、目的、位置三问由同一条链连接。",
    en: "Ownership, real power and purpose first; then how budget, people and resource allocation shape products, technology and the ten-year position. The three questions are sections of one causal chain.",
  },
  "company.author.axiom.power": { zh: "权力与目的", en: "Power and purpose" },
  "company.author.axiom.powerDesc": {
    zh: "谁控制？为谁服务？",
    en: "Who controls? Who is served?",
  },
  "company.author.axiom.three": { zh: "三问相连", en: "One chain" },
  "company.author.axiom.threeDesc": {
    zh: "公司、目的、位置，链条相连。",
    en: "Company, purpose and position, linked by one chain.",
  },
  "company.author.axiom.time": { zh: "十年尺度", en: "Ten-year horizon" },
  "company.author.axiom.timeDesc": {
    zh: "十年后还成立吗？",
    en: "Will it still hold in ten years?",
  },
  "company.author.axiom.evidence": { zh: "证据与叙事", en: "Evidence and narrative" },
  "company.author.axiom.evidenceDesc": {
    zh: "一手证据；叙事与现实的差额。",
    en: "Primary evidence; the gap between narrative and reality.",
  },
  "company.author.running": {
    zh: "正在按所有权、目的与位置读这家公司…",
    en: "Reading this company through ownership, purpose and position…",
  },
  "company.author.error": {
    zh: "作者判断生成失败，请稍后重试。",
    en: "Author's judgment failed. Try again later.",
  },
  "company.author.note": {
    zh: "价值立场与人性判断",
    en: "Value stance and human judgment",
  },
  "company.author.placeholder": {
    zh: "这一块留给作者的三观与人性判断，尚未接入。上线版本只预留位置，不生成结论。",
    en: "Reserved for the author's worldview and judgment of human nature. This launch version only reserves the slot; no conclusion is generated.",
  },
  "company.author.reserved": {
    zh: "预留位 · 不参与当前分析",
    en: "Reserved · not part of the current analysis",
  },

  // 筛选
  "filter.add": { zh: "筛选", en: "Filter" },
  "filter.field": { zh: "筛选字段", en: "Filter field" },
  "filter.operator": { zh: "筛选条件", en: "Operator" },
  "filter.value": { zh: "筛选值", en: "Filter value" },
  "filter.remove": { zh: "删除筛选条件", en: "Remove filter" },
  "filter.logic": { zh: "筛选逻辑", en: "Match logic" },
  "filter.match": { zh: "匹配", en: "Match" },
  "filter.all": { zh: "全部条件", en: "All conditions" },
  "filter.any": { zh: "任一条件", en: "Any condition" },
  "filter.results": { zh: "{n} 条结果", en: "{n} results" },
  "filter.clear": { zh: "清除", en: "Clear" },
  "filter.yearPlaceholder": { zh: "年份", en: "Year" },
  "filter.valuePlaceholder": { zh: "输入值", en: "Value" },

  // 排序字段
  "sort.clippedAt": { zh: "收集时间", en: "Collected" },
  "sort.year": { zh: "年份", en: "Year" },
  "sort.name": { zh: "名称", en: "Name" },
  "sort.kind": { zh: "类型", en: "Type" },
  "sort.source": { zh: "来源", en: "Source" },

  // 资料类型
  "kind.external": { zh: "外部资料", en: "External" },
  "kind.commentary": { zh: "评论", en: "Commentary" },
  "kind.test": { zh: "实测", en: "Hands-on" },
  "kind.interview": { zh: "访谈", en: "Interview" },
  "kind.company": { zh: "公司", en: "Company" },

  // 许可
  "license.own": { zh: "原创", en: "Original" },
  "license.authorized": { zh: "已授权", en: "Authorized" },
  "license.public": { zh: "公开许可", en: "Public license" },
  "license.link-only": { zh: "仅链接收录", en: "Link only" },
};

export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const entry = messages[key];
  let text = entry ? entry[lang] : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
