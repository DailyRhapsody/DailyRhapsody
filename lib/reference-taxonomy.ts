/**
 * Reference 的展示词表。与 lib/notion-reference.ts 的存储枚举一一对应；
 * 单独放一份是为了让客户端组件不必 import 服务端模块（会带上 Notion SDK）。
 */

export const REFERENCE_KIND_LABELS = {
  external: "外部资料",
  commentary: "行业评论",
  test: "实测报告",
  interview: "访谈",
} as const;

export const REFERENCE_LICENSE_LABELS = {
  own: "自有",
  authorized: "已授权",
  public: "公开转载",
  "link-only": "仅链接",
} as const;

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

export type ReferenceKindLabel = keyof typeof REFERENCE_KIND_LABELS;
export type ReferenceLicenseLabel = keyof typeof REFERENCE_LICENSE_LABELS;
