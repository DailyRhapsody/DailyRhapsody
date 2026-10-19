/**
 * Reference 的展示词表。与 lib/notion-reference.ts 的存储枚举一一对应；
 * 单独放一份是为了让客户端组件不必 import 服务端模块（会带上 Notion SDK）。
 */

export const REFERENCE_KIND_LABELS = {
  external: "外部资料",
  commentary: "行业评论",
  test: "实测报告",
  interview: "访谈",
  company: "行业档案",
} as const;

export const REFERENCE_LICENSE_LABELS = {
  own: "自有",
  authorized: "已授权",
  public: "公开转载",
  "link-only": "仅链接",
} as const;

/** 英文字段与中文一一对应；用于 ?lang=en 的界面。 */
export const REFERENCE_KIND_LABELS_EN = {
  external: "External",
  commentary: "Commentary",
  test: "Hands-on",
  interview: "Interview",
  company: "Company profile",
} as const;

export const REFERENCE_LICENSE_LABELS_EN = {
  own: "Original",
  authorized: "Authorized",
  public: "Public license",
  "link-only": "Link only",
} as const;

export function referenceKindLabel(
  kind: keyof typeof REFERENCE_KIND_LABELS,
  lang: "zh" | "en",
): string {
  return lang === "en" ? REFERENCE_KIND_LABELS_EN[kind] : REFERENCE_KIND_LABELS[kind];
}

export function referenceLicenseLabel(
  license: keyof typeof REFERENCE_LICENSE_LABELS,
  lang: "zh" | "en",
): string {
  return lang === "en" ? REFERENCE_LICENSE_LABELS_EN[license] : REFERENCE_LICENSE_LABELS[license];
}

/** 机器人行业的功能层切分；形态（人形/四足/双臂）放 Tag，不占 Domain */
export const REFERENCE_DOMAINS = [
  "导航定位",
  "感知",
  "运动控制",
  "操作",
  "本体与执行",
  "调度与集群",
  "安全与合规",
  "具身智能（VLA）",
  "数据与评测",
] as const;

/** 机器人本体/应用类型；Reference 列表和筛选共用。 */
export const REFERENCE_ROBOT_TYPES = [
  "工业机器人",
  "移动机器人",
  "仓储物流",
  "清洁机器人",
  "陪伴机器人",
  "人形机器人",
  "四足机器人",
  "服务机器人",
  "医疗机器人",
  "农业机器人",
  "安防机器人",
  "特种机器人",
  "教育机器人",
  "自动驾驶",
] as const;

export type ReferenceKindLabel = keyof typeof REFERENCE_KIND_LABELS;
export type ReferenceLicenseLabel = keyof typeof REFERENCE_LICENSE_LABELS;
