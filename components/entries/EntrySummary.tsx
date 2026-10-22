"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { entrySummaryProseClass, renderMarkdown } from "@/lib/markdown";
import { renderMermaidIn } from "@/lib/mermaid-render";
import { MAX_SUMMARY_LINES } from "./utils";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeColorScheme(onChange: () => void) {
  const mql = window.matchMedia(DARK_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function EntrySummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = text.split(/\n/).length > MAX_SUMMARY_LINES || text.length > 280;
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  const contentRef = useRef<HTMLDivElement>(null);
  const dark = useSyncExternalStore(
    subscribeColorScheme,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false
  );

  // 正文 HTML 只在内容变化时写入，不用 dangerouslySetInnerHTML：mermaid 会把代码块就地换成 SVG，
  // 而 React 在展开/收起、打开灯箱等重渲染时会按 dangerouslySetInnerHTML 重写整块 HTML，把图换回源码
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (root) root.innerHTML = rendered;
  }, [rendered]);

  // 内容写入后（或切换深浅色时）把 mermaid 代码块渲染成图
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    let cancelled = false;
    renderMermaidIn(root, dark, () => cancelled).catch(() => {
      // 加载失败保留源码块
    });
    return () => {
      cancelled = true;
    };
  }, [rendered, dark]);

  return (
    <div>
      {/* 正文图片按 Markdown 原位置与原始比例渲染；顶部图片区只放 Notion Image 字段。
          博客是滚动的动态流，不是文档：折叠态字号统一、不加粗（标题、加粗、表头都按正文显示），
          标题层级只在点开「展开」之后出现（见 lib/markdown.ts entrySummaryProseClass）。
          正文 13px（0.8125rem，随浏览器默认字号等比缩放；AI-Persona 对话、时间轴年份、后台列表与之一致）。
          引用与图注只用灰色区分，正文两端对齐（链接文字多是整串网址，允许断在任意处，
          否则网址整体挪到下一行、上一行被两端对齐拉散） */}
      <div
        className={entrySummaryProseClass(expanded)}
      >
        <div ref={contentRef} className="space-y-[1.15em]" />
      </div>
      {needsExpand && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-[0.75rem] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}
