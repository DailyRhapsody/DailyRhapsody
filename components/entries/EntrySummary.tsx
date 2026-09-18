"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { markdownPreviewProseClass, renderMarkdown } from "@/lib/markdown";
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
      {/* 正文图片与卡片首图同尺寸：小方图裁切，不按原图宽度铺开 */}
      <div
        className={`${markdownPreviewProseClass} text-[0.82rem] leading-relaxed [&_img]:h-24 [&_img]:w-24 [&_img]:bg-zinc-200 [&_img]:object-cover dark:[&_img]:bg-zinc-800 sm:[&_img]:h-20 sm:[&_img]:w-20 ${
          expanded ? "" : "max-h-36 overflow-hidden"
        }`}
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
