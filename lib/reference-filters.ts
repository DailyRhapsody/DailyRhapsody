import type { ReferenceListItem } from "@/hooks/useReference";
import { REFERENCE_KIND_LABELS, REFERENCE_ROBOT_TYPES, referenceDomainLabel, referenceRobotTypeLabel } from "@/lib/reference-taxonomy";

export type FilterField =
  | "kind"
  | "domain"
  | "tag"
  | "source"
  | "year"
  | "robotType"
  | "companyName"
  | "scenario"
  | "productForm"
  | "culture"
  | "market"
  | "companyTag"
  | "salesMode"
  | "listed"
  | "profitability";

export type FilterOperator =
  | "is"
  | "is_not"
  | "contains"
  | "does_not_contain"
  | "is_empty"
  | "is_not_empty"
  | "equals"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export type FilterLogic = "and" | "or";
export type FilterRule = {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: string;
};

export const FILTER_FIELDS: { key: FilterField; label: string; labelEn: string; type: "select" | "multi" | "text" | "number" }[] = [
  { key: "kind", label: "类型", labelEn: "Type", type: "select" },
  { key: "robotType", label: "机器人类型", labelEn: "Robot type", type: "multi" },
  { key: "domain", label: "领域", labelEn: "Domain", type: "multi" },
  { key: "tag", label: "标签", labelEn: "Tag", type: "multi" },
  { key: "source", label: "来源", labelEn: "Source", type: "select" },
  { key: "year", label: "年份", labelEn: "Year", type: "number" },
  { key: "companyName", label: "公司名称", labelEn: "Company", type: "text" },
  { key: "scenario", label: "场景定位", labelEn: "Use case", type: "multi" },
  { key: "productForm", label: "产品形态", labelEn: "Product form", type: "multi" },
  { key: "culture", label: "运营文化", labelEn: "Culture", type: "select" },
  { key: "market", label: "市场位置", labelEn: "Market", type: "multi" },
  { key: "companyTag", label: "公司标签", labelEn: "Company tag", type: "multi" },
  { key: "salesMode", label: "售卖形态", labelEn: "Sales model", type: "multi" },
  { key: "listed", label: "是否上市", labelEn: "Listed", type: "select" },
  { key: "profitability", label: "业务盈亏", labelEn: "P&L", type: "select" },
];

export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: "是",
  is_not: "不是",
  contains: "包含",
  does_not_contain: "不包含",
  is_empty: "为空",
  is_not_empty: "不为空",
  equals: "等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
};

export const FILTER_OPERATOR_LABELS_EN: Record<FilterOperator, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  does_not_contain: "does not contain",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  equals: "equals",
  gt: "greater than",
  gte: "greater or equal",
  lt: "less than",
  lte: "less or equal",
};

export function filterFieldLabel(field: FilterField, lang: "zh" | "en"): string {
  const entry = FILTER_FIELDS.find((f) => f.key === field);
  if (!entry) return field;
  return lang === "en" ? entry.labelEn : entry.label;
}

export function filterOperatorLabel(operator: FilterOperator, lang: "zh" | "en"): string {
  return lang === "en" ? FILTER_OPERATOR_LABELS_EN[operator] : FILTER_OPERATOR_LABELS[operator];
}

export function operatorsFor(type: "select" | "multi" | "text" | "number"): FilterOperator[] {
  if (type === "number") return ["equals", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"];
  if (type === "text") return ["contains", "does_not_contain", "is", "is_not", "is_empty", "is_not_empty"];
  return ["is", "is_not", "is_empty", "is_not_empty"];
}

export function fieldType(field: FilterField) {
  return FILTER_FIELDS.find((f) => f.key === field)?.type ?? "text";
}

export function valuesFor(item: ReferenceListItem, field: FilterField): string[] {
  switch (field) {
    case "kind":
      return [item.kind];
    case "domain":
      return item.domains;
    case "robotType":
      return item.robotTypes ?? [];
    case "tag":
      return item.tags;
    case "source":
      return item.source ? [item.source] : [];
    case "year":
      return item.year == null ? [] : [String(item.year)];
    case "companyName":
      return item.company?.companyName ? [item.company.companyName] : [];
    case "scenario":
      return item.company?.scenarios ?? [];
    case "productForm":
      return item.company?.productForms ?? [];
    case "culture":
      return item.company?.operationCulture ? [item.company.operationCulture] : [];
    case "market":
      return item.company?.markets ?? [];
    case "companyTag":
      return item.company?.companyTags ?? [];
    case "salesMode":
      return item.company?.salesModes ?? [];
    case "listed":
      return item.company?.listed ? [item.company.listed] : [];
    case "profitability":
      return item.company?.profitability ? [item.company.profitability] : [];
    default:
      return [];
  }
}

export function filterValueOptions(items: ReferenceListItem[], field: FilterField): string[] {
  if (field === "kind") return Object.keys(REFERENCE_KIND_LABELS);
  if (field === "robotType") {
    const values = new Set<string>(REFERENCE_ROBOT_TYPES);
    for (const item of items) for (const value of item.robotTypes ?? []) values.add(value);
    return [...values];
  }
  const values = new Set<string>();
  for (const item of items) for (const value of valuesFor(item, field)) values.add(value);
  return [...values].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function filterValueLabel(field: FilterField, value: string): string {
  if (field === "kind") return REFERENCE_KIND_LABELS[value as keyof typeof REFERENCE_KIND_LABELS] ?? value;
  return value;
}

function matches(item: ReferenceListItem, rule: FilterRule): boolean {
  const values = valuesFor(item, rule.field).filter(Boolean);
  const target = rule.value.trim();
  const lower = target.toLocaleLowerCase();
  const valueLower = values.map((v) => v.toLocaleLowerCase());

  switch (rule.operator) {
    case "is":
    case "equals":
      return valueLower.includes(lower);
    case "is_not":
      return !valueLower.includes(lower);
    case "contains":
      return !lower || valueLower.some((v) => v.includes(lower));
    case "does_not_contain":
      return !lower || !valueLower.some((v) => v.includes(lower));
    case "is_empty":
      return values.length === 0;
    case "is_not_empty":
      return values.length > 0;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const n = Number(target);
      if (!Number.isFinite(n) || values.length === 0) return false;
      return values.some((v) => {
        const value = Number(v);
        if (!Number.isFinite(value)) return false;
        if (rule.operator === "gt") return value > n;
        if (rule.operator === "gte") return value >= n;
        if (rule.operator === "lt") return value < n;
        return value <= n;
      });
    }
    default:
      return true;
  }
}

export function filterReferenceItems(
  items: ReferenceListItem[],
  rules: FilterRule[],
  logic: FilterLogic,
): ReferenceListItem[] {
  if (rules.length === 0) return items;
  return items.filter((item) =>
    logic === "and" ? rules.every((rule) => matches(item, rule)) : rules.some((rule) => matches(item, rule)),
  );
}
