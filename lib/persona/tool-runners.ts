/**
 * 工具实现登记表（v1：全部只读，数据来源必须由路由传入）。
 *
 * 与 tools.ts 的分工：那边是 schema（模型看得到的协议），这边是执行体。
 * RUNNERS 是 Record<ToolId, …>：目录加了工具而这里没登记，编译失败。
 *
 * 依赖禁区（tests/persona-skills.test.mjs 的守卫盯防）：不得 import
 * store / prompt / auth，也不得绕过路由直读文章缓存——数据一律从 ctx 取。
 * 这样「过滤后可见集合」这条隐私边界只在路由层定义一次，工具层无从绕过。
 */

import { retrieveSnippets, fullTextOf } from "@/lib/persona/retrieve";
import type { BlogFacts } from "@/lib/persona/facts";
import type { Diary } from "@/lib/notion";
import type { PersonaNote } from "@/lib/persona/types";
import { wrapUntrusted, type ToolId } from "@/lib/persona/tools";

export type ToolContext = {
  /** 路由层已过滤的可见文章集合（访客 = 公开且非回避主题） */
  diaries: Diary[];
  /** 人设包 notes（public 级只含可公开条目） */
  notes: PersonaNote[];
  /** 与页面同口径的博客概况（路由层用同一参数算好） */
  facts: BlogFacts | null;
};

export type ToolResult = {
  /** 给访客看的进度文案（如「正在翻我的文章…」） */
  label: string;
  /** 回填给模型的内容（已包装为不可信输入） */
  content: string;
};

const MAX_RESULT_CHARS = 8_000;

function argString(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object") return null;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

const RUNNERS: Record<ToolId, { label: string; run: (args: unknown, ctx: ToolContext) => string }> = {
  search_blog: {
    label: "正在翻我的文章…",
    run: (args, ctx) => {
      const query = argString(args, "query");
      if (!query) return JSON.stringify({ error: "缺少 query 参数" });
      const hits = retrieveSnippets(query, ctx.diaries, ctx.notes, 5);
      if (hits.length === 0) {
        return JSON.stringify({
          hits: [],
          note: "没有检索到相关文章。可以换关键词再试；仍然没有就如实说没写过。",
        });
      }
      return JSON.stringify({
        hits: hits.map((h) => ({
          id: h.id,
          type: h.source === "blog" ? "article" : "note",
          title: h.title,
          date: h.date ?? null,
          link: h.href ?? null,
          snippet: h.text.slice(0, 400),
        })),
      });
    },
  },
  read_article: {
    label: "正在读一篇文章…",
    run: (args, ctx) => {
      const id = argString(args, "id");
      if (!id) return JSON.stringify({ error: "缺少 id 参数" });
      const text = fullTextOf(ctx.diaries, ctx.notes, id, 6_000);
      if (!text) {
        return JSON.stringify({ error: `没有找到 id=${id} 的文章。只能读取 search_blog 结果里给出的 id。` });
      }
      return text;
    },
  },
  blog_stats: {
    label: "正在核对统计…",
    run: (_args, ctx) => {
      if (!ctx.facts) return JSON.stringify({ error: "统计暂不可用，请按上下文里的概况回答。" });
      return JSON.stringify(ctx.facts);
    },
  },
};

/**
 * 执行一次工具调用。返回 null 表示工具名未登记——调用方必须直接拒绝，绝不转发执行。
 * 实现内部异常不外抛：折成错误文本让模型看见并继续（失败不放大、不级联）。
 */
export function runTool(name: string, args: unknown, ctx: ToolContext): ToolResult | null {
  // 名字必须是字符串且是自有属性：'toString' 一类原型链名字按未登记拒绝；
  // 非字符串（数组等）会经 ToPropertyKey 命中登记名，从入口直接挡住
  if (typeof name !== "string" || !Object.hasOwn(RUNNERS, name)) return null;
  const runner = RUNNERS[name as ToolId];
  try {
    const raw = runner.run(args, ctx);
    const content = raw.length > MAX_RESULT_CHARS ? raw.slice(0, MAX_RESULT_CHARS) : raw;
    return { label: runner.label, content: wrapUntrusted(name, content) };
  } catch (e) {
    const why = e instanceof Error ? e.name : "unknown";
    return { label: runner.label, content: wrapUntrusted(name, `工具执行失败（${why}），请基于已有资料回答。`) };
  }
}
