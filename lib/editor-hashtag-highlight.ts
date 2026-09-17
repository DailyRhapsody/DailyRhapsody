import { HASHTAG_NAME_BODY } from "@/lib/hashtags";

// 开闭围栏的反引号数量一致（Notion 代码块里含 ``` 时会用更长的围栏，见 lib/notion.ts codeFence）
const FENCE = /(`{3,})[\s\S]*?\1/g;

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 给紧贴 # 的 #标签 包一层 span（与 extractHashtagsFromMarkdown 一致）。
 * 供 renderMarkdown 在渲染前注入，用于预览/前台正文中的标签配色；不写入数据库原文。
 */
export function highlightHashtagsForEditorHtml(markdown: string): string {
  if (!markdown) return "";
  let out = "";
  let last = 0;
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(markdown)) !== null) {
    out += highlightProse(markdown.slice(last, m.index));
    out += escapeHtml(m[0]);
    last = m.index + m[0].length;
  }
  out += highlightProse(markdown.slice(last));
  return out;
}

/**
 * 前台渲染专用：与 highlightHashtagsForEditorHtml 的区别只在转义。
 *  - 代码块原样交给 marked，由 marked 自己转义一次。之前先整体转义、marked 再转义，
 *    mermaid 源码里的 --> 显示成 --&gt;，流程图无法渲染。
 *  - 正文不转义 >：< 已转义，拼不出标签；保留 > 才能让 marked 识别引用块
 *    （Notion 的 callout / quote 之前显示成以「&gt;」开头的普通段落）。
 * 编辑器底层高亮区不经过 marked，仍需完整转义，所以不能共用。
 */
export function highlightHashtagsForRender(markdown: string): string {
  if (!markdown) return "";
  let out = "";
  let last = 0;
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(markdown)) !== null) {
    out += highlightProse(markdown.slice(last, m.index), escapeHtmlKeepGt);
    out += m[0];
    last = m.index + m[0].length;
  }
  out += highlightProse(markdown.slice(last), escapeHtmlKeepGt);
  return out;
}

function escapeHtmlKeepGt(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

const BEFORE_HASH = new RegExp(
  String.raw`(^|[\s\u3000,，.;；:：!！?？。、（）()\[\]【】《》「」])(#${HASHTAG_NAME_BODY})`,
  "gu"
);

function highlightProse(s: string, escape: (text: string) => string = escapeHtml): string {
  const escaped = escape(s);
  return escaped.replace(
    BEFORE_HASH,
    (_, before: string, hashTag: string) =>
      `${before}<span class="dr-md-editor-tag">${hashTag}</span>`
  );
}
