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
