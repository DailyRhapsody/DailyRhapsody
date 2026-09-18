import sanitizeHtml from "sanitize-html";
import { marked } from "marked";

/**
 * 等价于原 isomorphic-dompurify 调用：
 *   DOMPurify.sanitize(html, {
 *     USE_PROFILES: { html: true },
 *     ADD_TAGS: ["input"],
 *     ADD_ATTR: ["target", "rel", "checked", "disabled", "type"],
 *   })
 *
 * 切换到 sanitize-html 是为了摆脱 jsdom（间接依赖了 ESM-only 的
 * @exodus/bytes，在 Turbopack SSR 阶段以 require() 加载会触发
 * ERR_REQUIRE_ESM，导致 /entries 在 Vercel runtime 500）。sanitize-html
 * 基于 parse5，纯 JS，前后端通用。
 *
 * DOMPurify 的 html profile 大致允许：常见块/行内元素 + 安全的 a/img/table/list/code/blockquote/...
 * 这里手工列出对齐集合 + 显式追加 `input`（task-list checkbox）。
 */
const ALLOWED_TAGS: string[] = [
  // 段落 / 标题 / 文本
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr", "div", "span",
  "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "mark",
  "small", "sub", "sup",
  "blockquote", "cite", "q",
  // 列表
  "ul", "ol", "li", "dl", "dt", "dd",
  // 链接 / 媒体
  "a", "img", "picture", "source", "figure", "figcaption",
  // 代码
  "code", "pre", "kbd", "samp", "var",
  // 表格
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  // 任务列表 checkbox
  "input",
];

const ALLOWED_ATTRS: Record<string, string[]> = {
  "*": ["class", "id", "title", "lang", "dir"],
  a: ["href", "name", "target", "rel"],
  img: ["src", "srcset", "alt", "width", "height", "loading"],
  source: ["src", "srcset", "type", "media", "sizes"],
  th: ["align", "colspan", "rowspan", "scope"],
  td: ["align", "colspan", "rowspan"],
  col: ["span"],
  colgroup: ["span"],
  input: ["type", "checked", "disabled"],
};

function sanitize(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    // 默认 schemes 与 DOMPurify 一致：禁止 javascript:
    allowedSchemes: ["http", "https", "mailto", "tel", "data"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: true,
    // sanitize-html 默认会把单标签 input 输出为 <input ... />；保留即可
    selfClosing: ["img", "br", "hr", "input", "source", "col"],
  });
}
import { highlightHashtagsForRender } from "@/lib/editor-hashtag-highlight";
import { stripHashtagOnlyLinesInProse } from "@/lib/hashtags";

// 与 lib/editor-hashtag-highlight.ts 的 FENCE 一致：开闭围栏反引号数量相同
const FENCED_BLOCK = /(`{3,})[\s\S]*?\1/g;

/**
 * 渲染管线与 Notion 常用 Markdown 快捷一致：`# `…`###### ` + 空格 为标题（六级），
 * `>` 引用、`---` 分隔、`- [ ]` 待办、列表与 GFM 表格等均由 marked 处理。
 * 唯一例外：紧贴 `#` 的 `#标签` 仍按正文标签提取（Notion 标题须在 `#` 后加空格）。
 * 可选保留 `=` 标题写法（`= `…`====== `），与 `# ` 等价。
 */
function notionOrEqualsHeadingsToAtx(prose: string): string {
  const lines = prose.split("\n");
  const afterNotion: string[] = [];
  for (const line of lines) {
    const bq = line.match(/^(\s{0,3}(?:>\s*)+)(#{1,6})\s+(.+)$/);
    if (bq) {
      afterNotion.push(`${bq[1]}${"=".repeat(bq[2].length)} ${bq[3]}`);
      continue;
    }
    const hx = line.match(/^(\s{0,3})(#{1,6})\s+(.+)$/);
    if (hx) {
      afterNotion.push(`${hx[1]}${"=".repeat(hx[2].length)} ${hx[3]}`);
      continue;
    }
    afterNotion.push(line);
  }
  const out: string[] = [];
  for (const line of afterNotion) {
    const bqEq = line.match(/^(\s{0,3}(?:>\s*)+)((?:=){1,6})\s+(.+)$/);
    if (bqEq) {
      const level = bqEq[2].length;
      out.push(`${bqEq[1]}${"#".repeat(level)} ${bqEq[3]}`);
      continue;
    }
    const eq = line.match(/^(\s*)(={1,6})\s+(.+)$/);
    if (eq) {
      const level = eq[2].length;
      out.push(`${eq[1]}${"#".repeat(level)} ${eq[3]}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function mapOutsideFencedBlocks(src: string, fn: (prose: string) => string): string {
  let result = "";
  let last = 0;
  FENCED_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCED_BLOCK.exec(src)) !== null) {
    result += fn(src.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  result += fn(src.slice(last));
  return result;
}

/**
 * Markdown 会把「三个及以上连续换行」压成「只分一段」，与编辑器里多空行不一致。
 * 把多出来的空行变成只含 NBSP 的独立段落，前台与预览才能留出对应竖直间距。
 */
function preserveExtraBlankLinesInProse(prose: string): string {
  if (!prose) return prose;
  return prose.replace(/(?:\n[ \t]*){3,}/g, (full) => {
    const n = full.match(/\n/g)?.length ?? 0;
    const extra = n - 2;
    if (extra <= 0) return full;
    return (
      "\n\n" +
      Array.from({ length: extra }, () => "\u00a0").join("\n\n") +
      "\n\n"
    );
  });
}

function escapeAttr(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

/**
 * 图注 / 表注：独占一段的「图 1 Notion 三库到前端的同步流程」「表 2：协议矩阵」。
 * 不带句读标点、40 字以内，才算图注；「图 11 的失败处置分支就是这条路径，……」这类正文不算。
 */
const CAPTION_RE = /^[图表]\s*\d+(?:[.-]\d+)*(?:\s*[:：、.]\s*|\s+)[^\n，。；！？,;!?]{1,40}$/;

marked.use({
  gfm: true,
  breaks: true,
  hooks: {
    postprocess(html) {
      return sanitize(html);
    },
  },
  renderer: {
    paragraph({ text, tokens }) {
      if (!CAPTION_RE.test(text.trim())) return false;
      return `<p class="dr-caption">${this.parser.parseInline(tokens)}</p>\n`;
    },
    link({ href, title, tokens }) {
      if (href == null || href === "") return "";
      const inner = this.parser.parseInline(tokens);
      const t =
        title != null && title !== ""
          ? ` title="${escapeAttr(String(title))}"`
          : "";
      return `<a href="${escapeAttr(String(href))}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
  },
});

/**
 * Markdown → HTML。标题与 Notion 一致用 `# `…`###### `（`#` 后必须有空格），
 * 亦可手写 `= `…`====== `；`#标签`（无空格）仍为正文标签。
 */
function prepareFencedProseChunk(chunk: string): string {
  return preserveExtraBlankLinesInProse(
    stripHashtagOnlyLinesInProse(notionOrEqualsHeadingsToAtx(chunk))
  );
}

export function renderMarkdown(markdown: string): string {
  const src = (markdown ?? "").replace(/\r\n/g, "\n");
  const prepped = mapOutsideFencedBlocks(src, prepareFencedProseChunk);
  const withTags = highlightHashtagsForRender(prepped);
  return marked.parse(withTags, { async: false }) as string;
}

/**
 * 与前台 / 编辑器预览区共用的样式：列表层级、表格、代码块、图片、引用等与 GFM 输出对齐。
 */
export const markdownPreviewProseClass =
  "prose prose-zinc max-w-none dark:prose-invert break-words [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_ul_ul]:mt-1 [&_ul_ul]:list-[circle] [&_ul_ul_ul]:list-[square] [&_ol_ol]:mt-1 [&_ol_ol]:list-[lower-alpha] [&_ol_ol_ol]:list-[lower-roman] [&_a]:break-words [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:text-left [&_th]:border [&_th]:border-zinc-300 [&_th]:px-2 [&_th]:py-1.5 [&_td]:border [&_td]:border-zinc-300 [&_td]:px-2 [&_td]:py-1.5 dark:[&_th]:border-zinc-600 dark:[&_td]:border-zinc-600 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:text-sm [&_pre]:bg-zinc-900 [&_pre]:text-zinc-100 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_p_code]:rounded [&_p_code]:bg-zinc-100 [&_p_code]:px-1 [&_p_code]:py-0.5 dark:[&_p_code]:bg-zinc-800 [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg [&_blockquote]:border-l-4 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-4 [&_blockquote]:not-italic dark:[&_blockquote]:border-zinc-600 [&_hr]:my-8 [&_.dr-mermaid]:my-3 [&_.dr-mermaid]:overflow-x-auto [&_.dr-mermaid_svg]:mx-auto [&_.dr-mermaid_svg]:h-auto [&_.dr-mermaid_svg]:max-w-full [&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:align-middle [&_.dr-md-editor-tag]:font-medium [&_.dr-md-editor-tag]:text-violet-700 dark:[&_.dr-md-editor-tag]:text-sky-400";
