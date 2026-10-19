"use client";

import { useMemo } from "react";
import type { ReferenceListItem } from "@/hooks/useReference";
import {
  FILTER_FIELDS,
  FILTER_OPERATOR_LABELS,
  fieldType,
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

/** Notion 式横向筛选条：条件直接显示为可编辑 chip，不再额外展开大面板。 */
export function ReferenceFilters({
  items,
  rules,
  logic,
  resultCount,
  onRulesChange,
  onLogicChange,
}: {
  items: ReferenceListItem[];
  rules: FilterRule[];
  logic: FilterLogic;
  resultCount: number;
  onRulesChange: (rules: FilterRule[]) => void;
  onLogicChange: (logic: FilterLogic) => void;
}) {
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
    <section className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
      <button
        type="button"
        onClick={addRule}
        className="inline-flex h-8 items-center gap-1 rounded-full border border-zinc-200 bg-white/60 px-3 text-xs text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        <span className="text-sm leading-none text-zinc-400" aria-hidden>+</span>
        筛选
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
              aria-label="筛选字段"
            >
              {FILTER_FIELDS.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>

            <select
              value={rule.operator}
              onChange={(event) =>
                updateRule(rule.id, { operator: event.target.value as FilterOperator })
              }
              className={`${chipSelect} max-w-[5.5rem] text-zinc-500 dark:text-zinc-400`}
              aria-label="筛选条件"
            >
              {operatorsFor(type).map((operator) => (
                <option key={operator} value={operator}>
                  {FILTER_OPERATOR_LABELS[operator]}
                </option>
              ))}
            </select>

            {rule.operator === "is_empty" || rule.operator === "is_not_empty" ? null : type ===
                "text" || type === "number" || fieldOptions.length === 0 ? (
              <input
                type={type === "number" ? "number" : "text"}
                value={rule.value}
                onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                placeholder={type === "number" ? "年份" : "输入值"}
                className="h-6 w-24 min-w-0 rounded-full border-0 bg-zinc-100 px-2 text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:ring-1 focus:ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:focus:ring-zinc-600"
                aria-label="筛选值"
              />
            ) : (
              <select
                value={rule.value}
                onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                className={`${chipSelect} font-medium text-zinc-800 dark:text-zinc-100`}
                aria-label="筛选值"
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
              aria-label="删除筛选条件"
            >
              ×
            </button>
          </div>
        );
      })}

      {rules.length > 1 ? (
        <label className="inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          匹配
          <select
            value={logic}
            onChange={(event) => onLogicChange(event.target.value as FilterLogic)}
            className="rounded-md border-0 bg-zinc-100 py-1 pl-2 pr-6 text-xs text-zinc-700 outline-none focus:ring-1 focus:ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:focus:ring-zinc-600"
            aria-label="筛选逻辑"
          >
            <option value="and">全部条件</option>
            <option value="or">任一条件</option>
          </select>
        </label>
      ) : null}

      {rules.length > 0 ? (
        <>
          <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500">
            {resultCount} 条结果
          </span>
          <button
            type="button"
            onClick={() => onRulesChange([])}
            className="rounded-full px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            清除
          </button>
        </>
      ) : null}
    </section>
  );
}
