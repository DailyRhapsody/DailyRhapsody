"use client";

import { useMemo, type ReactNode } from "react";
import type { ReferenceListItem } from "@/hooks/useReference";
import { useLang } from "@/components/LangProvider";
import {
  FILTER_FIELDS,
  fieldType,
  filterFieldLabel,
  filterOperatorLabel,
  filterValueLabel,
  filterValueOptions,
  operatorsFor,
  type FilterField,
  type FilterLogic,
  type FilterOperator,
  type FilterRule,
} from "@/lib/reference-filters";

const chipSelect =
  "min-w-0 max-w-[8rem] cursor-pointer truncate border-0 bg-transparent py-0.5 pr-4 text-xs text-zinc-700 outline-none focus:ring-0 dark:text-zinc-200";

function newRule(field: FilterField = "kind", value = ""): FilterRule {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    field,
    operator: operatorsFor(fieldType(field))[0],
    value,
  };
}

/**
 * Notion 式横向筛选条：条件直接显示为可编辑 chip，不再额外展开大面板。
 * 排序与搜索从「trailing」插槽渲染在同一行的右端，不再各自占一行 ——
 * 用户明确要求工具条只有一行（筛选 → 排序 → 搜索），上下两行会被视为改错。
 */
export function ReferenceFilters({
  items,
  rules,
  logic,
  resultCount,
  onRulesChange,
  onLogicChange,
  trailing,
}: {
  items: ReferenceListItem[];
  rules: FilterRule[];
  logic: FilterLogic;
  resultCount: number;
  onRulesChange: (rules: FilterRule[]) => void;
  onLogicChange: (logic: FilterLogic) => void;
  /** 同一行右端的工具（排序、搜索），由调用方传入以免重复实现工具条外壳。 */
  trailing?: ReactNode;
}) {
  const { t, lang } = useLang();
  const options = useMemo(() => {
    const result = {} as Record<FilterField, string[]>;
    for (const field of FILTER_FIELDS) result[field.key] = filterValueOptions(items, field.key);
    return result;
  }, [items]);

  const updateRule = (id: string, patch: Partial<FilterRule>) => {
    onRulesChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };

  const addRule = () => {
    const field: FilterField = "kind";
    onRulesChange([...rules, newRule(field, options[field][0] ?? "")]);
  };

  return (
    <section className="mb-5 flex flex-wrap items-start gap-x-2 gap-y-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
      {/* 左列：+ 筛选与条件 chip 都在这里内部换行，绝不把右侧那组挤到下一行。
          否则一旦有筛选条件，排序 / 搜索就会掉到第二行，看起来又变回两行工具条。 */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-2">
        <button
          type="button"
          onClick={addRule}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-zinc-200 bg-white/60 px-3 text-xs text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <span className="text-sm leading-none text-zinc-400" aria-hidden>+</span>
          {t("filter.add")}
        </button>

        {rules.map((rule) => {
          const type = fieldType(rule.field);
          const fieldOptions = options[rule.field] ?? [];
          return (
            <div
              key={rule.id}
              className="inline-flex min-h-8 max-w-full flex-wrap items-center gap-0.5 rounded-full border border-zinc-200 bg-white/70 py-0.5 pl-2 pr-0.5 text-xs text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-300"
            >
              <select
                value={rule.field}
                onChange={(event) => {
                  const field = event.target.value as FilterField;
                  updateRule(rule.id, {
                    field,
                    operator: operatorsFor(fieldType(field))[0],
                    value:
                      fieldType(field) === "text" || fieldType(field) === "number"
                        ? ""
                        : options[field][0] ?? "",
                  });
                }}
                className={chipSelect}
                aria-label={t("filter.field")}
              >
                {FILTER_FIELDS.map((field) => (
                  <option key={field.key} value={field.key}>
                    {filterFieldLabel(field.key, lang)}
                  </option>
                ))}
              </select>

              <select
                value={rule.operator}
                onChange={(event) =>
                  updateRule(rule.id, { operator: event.target.value as FilterOperator })
                }
                className={`${chipSelect} max-w-[5.5rem] text-zinc-500 dark:text-zinc-400`}
                aria-label={t("filter.operator")}
              >
                {operatorsFor(type).map((operator) => (
                  <option key={operator} value={operator}>
                    {filterOperatorLabel(operator, lang)}
                  </option>
                ))}
              </select>

              {rule.operator === "is_empty" || rule.operator === "is_not_empty" ? null : type ===
                  "text" || type === "number" || fieldOptions.length === 0 ? (
                <input
                  type={type === "number" ? "number" : "text"}
                  value={rule.value}
                  onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                  placeholder={type === "number" ? t("filter.yearPlaceholder") : t("filter.valuePlaceholder")}
                  className="h-6 w-24 min-w-0 rounded-full border-0 bg-zinc-100 px-2 text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:ring-1 focus:ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:focus:ring-zinc-600"
                  aria-label={t("filter.value")}
                />
              ) : (
                <select
                  value={rule.value}
                  onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                  className={`${chipSelect} font-medium text-zinc-800 dark:text-zinc-100`}
                  aria-label={t("filter.value")}
                >
                  {fieldOptions.map((value) => (
                    <option key={value} value={value}>
                      {filterValueLabel(rule.field, value)}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                onClick={() => onRulesChange(rules.filter((item) => item.id !== rule.id))}
                className="ml-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm leading-none text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                aria-label={t("filter.remove")}
              >
                ×
              </button>
            </div>
          );
        })}

        {rules.length > 1 ? (
          <label className="inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t("filter.match")}
            <select
              value={logic}
              onChange={(event) => onLogicChange(event.target.value as FilterLogic)}
              className="rounded-md border-0 bg-zinc-100 py-1 pl-2 pr-6 text-xs text-zinc-700 outline-none focus:ring-1 focus:ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:focus:ring-zinc-600"
              aria-label={t("filter.logic")}
            >
              <option value="and">{t("filter.all")}</option>
              <option value="or">{t("filter.any")}</option>
            </select>
          </label>
        ) : null}
      </div>

      {/* 右端一组：结果数 / 清除 / 排序 / 搜索。sm 以上固定在同一行最右且不收缩，
          窄屏（手机）整组独占一行、搜索框铺满。 */}
      <div className="ml-auto flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2">
        {rules.length > 0 ? (
          <>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              {t("filter.results", { n: resultCount })}
            </span>
            <button
              type="button"
              onClick={() => onRulesChange([])}
              className="rounded-full px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              {t("filter.clear")}
            </button>
          </>
        ) : null}
        {trailing}
      </div>
    </section>
  );
}
