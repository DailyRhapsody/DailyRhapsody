// Reference 列表的模糊搜索与多字段排序（纯函数，供 UI 与测试共用）。
//
// 数据量：/reference 一次拉 200 条，当前 133 条。搜索与排序都在客户端做，
// 交互即时、不额外打 API；超过单页 200 条时再考虑下沉到 /api/reference。

export type SortField = "clippedAt" | "year" | "name" | "kind" | "source";
export type SortDir = "asc" | "desc";
export type SortKey = { field: SortField; dir: SortDir };

export const SORT_FIELDS: { key: SortField; label: string }[] = [
  { key: "clippedAt", label: "收集时间" },
  { key: "year", label: "年份" },
  { key: "name", label: "名称" },
  { key: "kind", label: "类型" },
  { key: "source", label: "来源" },
];

export const SORT_FIELD_KEYS = SORT_FIELDS.map((f) => f.key);

type SortableItem = {
  id: string;
  name: string;
  titleZh?: string | null;
  summary?: string;
  source: string;
  tags: string[];
  clippedAt: string;
  kind: string;
  domains: string[];
  robotTypes?: string[];
  year: number | null;
  company?: {
    companyName?: string;
    productForms?: string[];
    scenarios?: string[];
    markets?: string[];
    companyTags?: string[];
    operationCulture?: string;
    salesModes?: string[];
    headcount?: string | number | null;
    listed?: string;
  } | null;
};

/** 归一化：大小写、全角/半角、连续空白都不该影响匹配。 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

/** 参与搜索的字段：标题/摘要/来源/标签/领域/机型/公司档案。 */
export function searchableText(item: SortableItem): string {
  const company = item.company;
  const parts = [
    item.name,
    item.titleZh ?? "",
    item.summary ?? "",
    item.source,
    item.tags.join(" "),
    item.domains.join(" "),
    (item.robotTypes ?? []).join(" "),
    company?.companyName ?? "",
    (company?.productForms ?? []).join(" "),
    (company?.scenarios ?? []).join(" "),
    (company?.markets ?? []).join(" "),
    (company?.companyTags ?? []).join(" "),
    company?.operationCulture ?? "",
    (company?.salesModes ?? []).join(" "),
    company?.headcount ?? "",
    company?.listed ?? "",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * 模糊匹配：空白分词后每个词都要命中（AND），词内按子串匹配。
 * 这样「iRobot 扫地」能命中，输入顺序不影响结果；中文不需要分词器。
 */
export function matchesQuery(item: SortableItem, query: string): boolean {
  const tokens = normalizeText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeText(searchableText(item));
  return tokens.every((token) => haystack.includes(token));
}

function displayName(item: SortableItem): string {
  return item.titleZh?.trim() || item.name || "";
}

/** 缺失值统一排在最后，与升/降序无关，避免「年份不详」跑到最前面。 */
function compareField(a: SortableItem, b: SortableItem, field: SortField): number {
  switch (field) {
    case "year": {
      if (a.year == null && b.year == null) return 0;
      if (a.year == null) return 1;
      if (b.year == null) return -1;
      return a.year - b.year;
    }
    case "clippedAt": {
      const at = Date.parse(a.clippedAt);
      const bt = Date.parse(b.clippedAt);
      const av = Number.isNaN(at) ? null : at;
      const bv = Number.isNaN(bt) ? null : bt;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    }
    case "name":
      return displayName(a).localeCompare(displayName(b), "zh-Hans-CN");
    case "kind":
      return a.kind.localeCompare(b.kind);
    case "source":
      return a.source.localeCompare(b.source, "zh-Hans-CN");
    default:
      return 0;
  }
}

/**
 * 多键排序：先按第一个键，相等再看第二个键；都相等时回落到收集时间倒序 + id，
 * 保证同一份数据每次渲染顺序一致（列表不会自己抖动）。
 */
export function sortReferenceItems<T extends SortableItem>(items: T[], keys: SortKey[]): T[] {
  const list = [...items];
  const missing = (item: T, field: SortField): boolean => {
    if (field === "year") return item.year == null;
    if (field === "clippedAt") return Number.isNaN(Date.parse(item.clippedAt));
    return false;
  };
  list.sort((a, b) => {
    for (const key of keys) {
      // 缺失值永远沉底：先判空，再判方向，避免降序把 null 顶到最前面。
      const aMissing = missing(a, key.field);
      const bMissing = missing(b, key.field);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing && bMissing) continue;
      const result = compareField(a, b, key.field);
      if (result !== 0) return key.dir === "asc" ? result : -result;
    }
    const fallback = compareField(a, b, "clippedAt");
    if (fallback !== 0) return -fallback;
    return a.id.localeCompare(b.id);
  });
  return list;
}

/** 从 URL 参数解析排序，非法值一律忽略，最多保留两个键。 */
export function parseSortKeys(value: string | null | undefined): SortKey[] {
  if (!value) return [];
  const keys: SortKey[] = [];
  for (const chunk of value.split(",")) {
    const [field, dir] = chunk.split(":");
    if (!SORT_FIELD_KEYS.includes(field as SortField)) continue;
    if (dir !== "asc" && dir !== "desc") continue;
    if (keys.some((k) => k.field === field)) continue;
    keys.push({ field: field as SortField, dir });
    if (keys.length === 2) break;
  }
  return keys;
}

/** 序列化回 URL；空数组返回空串（不写 sort 参数）。 */
export function serializeSortKeys(keys: SortKey[]): string {
  return keys.map((k) => `${k.field}:${k.dir}`).join(",");
}

export function sortFieldLabel(field: SortField): string {
  return SORT_FIELDS.find((f) => f.key === field)?.label ?? field;
}
