"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

  // rendered 变化时 React 会重置 innerHTML，需要重新把 mermaid 代码块换成图
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
      <div
        className={`${markdownPreviewProseClass} text-[0.82rem] leading-relaxed ${
          expanded ? "" : "max-h-36 overflow-hidden"
        }`}
      >
        <div
          ref={contentRef}
          className="space-y-[1.15em]"
          dangerouslySetInnerHTML={{ __html: rendered }}
        />
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
