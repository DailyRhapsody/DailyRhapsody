"use client";

import { useMemo, useState } from "react";
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

const selectClass =
  "h-8 min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 outline-none transition-colors focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";

function newRule(field: FilterField = "kind", value = ""): FilterRule {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    field,
    operator: operatorsFor(fieldType(field))[0],
    value,
  };
}

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
  const [open, setOpen] = useState(rules.length > 0);
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
    setOpen(true);
  };

  return (
    <section className="mb-5 rounded-xl border border-zinc-200 bg-white/60 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          筛选
          {rules.length > 0 ? (
            <span className="rounded-full bg-zinc-900 px-1.5 py-0.5 text-[0.62rem] text-white dark:bg-zinc-100 dark:text-zinc-900">
              {rules.length}
            </span>
          ) : null}
          <span className={`text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
            ⌄
          </span>
        </button>

        {rules.length > 0 ? (
          <>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              共 <strong className="font-medium text-zinc-800 dark:text-zinc-200">{resultCount}</strong> 条
            </span>
            <label className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
              匹配
              <select
                value={logic}
                onChange={(event) => onLogicChange(event.target.value as FilterLogic)}
                className={selectClass}
                aria-label="筛选逻辑"
              >
                <option value="and">全部条件</option>
                <option value="or">任一条件</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => onRulesChange([])}
              className="rounded px-1.5 py-1 text-xs text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              清除
            </button>
          </>
        ) : (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">按类型、机器人类型、领域、公司档案组合筛选</span>
        )}
      </div>

      {open ? (
        <div className="mt-3 space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          {rules.length === 0 ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-500">还没有条件，添加一个开始筛选。</p>
          ) : null}
          {rules.map((rule) => {
            const type = fieldType(rule.field);
            const fieldOptions = options[rule.field] ?? [];
            return (
              <div key={rule.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <select
                  value={rule.field}
                  onChange={(event) => {
                    const field = event.target.value as FilterField;
                    updateRule(rule.id, {
                      field,
                      operator: operatorsFor(fieldType(field))[0],
                      value: fieldType(field) === "text" || fieldType(field) === "number" ? "" : options[field][0] ?? "",
                    });
                  }}
                  className={`${selectClass} sm:w-32`}
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
                  onChange={(event) => updateRule(rule.id, { operator: event.target.value as FilterOperator })}
                  className={`${selectClass} sm:w-24`}
                  aria-label="筛选条件"
                >
                  {operatorsFor(type).map((operator) => (
                    <option key={operator} value={operator}>
                      {FILTER_OPERATOR_LABELS[operator]}
                    </option>
                  ))}
                </select>

                {rule.operator === "is_empty" || rule.operator === "is_not_empty" ? (
                  <span className="flex h-8 flex-1 items-center px-2 text-xs text-zinc-400 dark:text-zinc-500">无需填写值</span>
                ) : type === "text" || type === "number" || fieldOptions.length === 0 ? (
                  <input
                    type={type === "number" ? "number" : "text"}
                    value={rule.value}
                    onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                    placeholder={type === "number" ? "输入年份" : "输入内容"}
                    className={`${selectClass} flex-1`}
                    aria-label="筛选值"
                  />
                ) : (
                  <select
                    value={rule.value}
                    onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                    className={`${selectClass} flex-1`}
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
                  className="inline-flex h-8 items-center justify-center rounded-md px-2 text-lg leading-none text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="删除筛选条件"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addRule}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-500 transition-colors hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            + 添加条件
          </button>
        </div>
      ) : null}
    </section>
  );
}
