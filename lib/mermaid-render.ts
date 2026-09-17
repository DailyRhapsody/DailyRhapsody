"use client";

/**
 * 把正文里的 ```mermaid 代码块渲染成 SVG 流程图（Notion 代码块语言选 Mermaid）。
 *
 * - mermaid 体积大，只在页面确实出现 mermaid 代码块时动态加载
 * - securityLevel: "strict"：mermaid 自带 DOMPurify 清理节点文字，不需要把 svg 加进 sanitize 白名单
 * - 渲染失败（语法错误等）保留源码块
 * - 源码存进 data 属性，切换深浅色时能按新主题重绘
 */

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderSeq = 0;
// mermaid.initialize 是全局设置，多张卡片同时渲染时串行，避免主题互相覆盖
let queue: Promise<void> = Promise.resolve();

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

export function renderMermaidIn(
  root: HTMLElement,
  dark: boolean,
  isCancelled: () => boolean
): Promise<void> {
  const sources = root.querySelectorAll("pre > code.language-mermaid, figure.dr-mermaid");
  if (sources.length === 0) return Promise.resolve();

  const run = async () => {
    const mermaid = await loadMermaid();
    if (isCancelled()) return;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      // 默认会在 body 末尾画一张「Syntax error」错误图且抛错前不清理；出错时只保留源码块
      suppressErrorRendering: true,
    });
    const targets = Array.from(
      root.querySelectorAll<HTMLElement>("pre > code.language-mermaid, figure.dr-mermaid")
    );
    for (const el of targets) {
      if (isCancelled() || !el.isConnected) return;
      const isFigure = el.tagName === "FIGURE";
      const source = isFigure ? el.dataset.mermaidSource ?? "" : el.textContent ?? "";
      if (!source.trim()) continue;
      try {
        const { svg } = await mermaid.render(`dr-mermaid-${++renderSeq}`, source);
        if (isCancelled() || !el.isConnected) return;
        if (isFigure) {
          el.innerHTML = svg;
        } else {
          const figure = document.createElement("figure");
          figure.className = "dr-mermaid";
          figure.dataset.mermaidSource = source;
          figure.innerHTML = svg;
          el.parentElement?.replaceWith(figure);
        }
      } catch {
        // 语法错误：保留源码块
      }
    }
  };

  queue = queue.then(run, run);
  return queue;
}
