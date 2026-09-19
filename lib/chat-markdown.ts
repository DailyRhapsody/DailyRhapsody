import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

/**
 * 数字人回复专用的 Markdown 渲染。
 *
 * 不复用 lib/markdown.ts 的 renderMarkdown：那条管线带博客专属预处理（#标签高亮、
 * 删纯标签行、Notion 标题转换），而且 marked.use 改的是全局单例；
 * 另建独立实例，互不影响。
 *
 * 白名单去掉 img：回复一旦被提示注入，外链图片可以把数据拼在 URL 里带出去。
 * 原始 HTML 一律按文本显示，所有链接在净化出口统一重算 target/rel。
 */
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // 模型输出的原始 HTML 不当标签解析，原样显示为文字
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      if (!href) return this.parser.parseInline(tokens);
      const inner = this.parser.parseInline(tokens);
      const t = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${escapeAttr(href)}"${t}>${inner}</a>`;
    },
  },
});

/** 以单个 / 开头的是站内路径；// 与 /\ 开头会被浏览器当成站外地址 */
function isSiteRelative(href: string): boolean {
  return href.startsWith("/") && href[1] !== "/" && href[1] !== "\\";
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "s", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    code: ["class"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  transformTags: {
    // 链接的统一出口：站内文章（/entries#entry-…）在当前页跳转，其余一律新标签页打开，
    // 丢弃模型给出的 target/rel
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      const out: sanitizeHtml.Attributes = { href };
      if (attribs.title) out.title = attribs.title;
      if (!isSiteRelative(href)) {
        out.target = "_blank";
        out.rel = "noopener noreferrer nofollow";
      }
      return { tagName, attribs: out };
    },
  },
};

function escapeAttr(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** 流式输出时代码围栏可能还没闭合，临时补上，否则整段代码会被当正文解析 */
function closeOpenFence(src: string): string {
  const fences = src.match(/^ {0,3}(`{3,}|~{3,})/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${src}\n\`\`\`` : src;
}

export function renderChatMarkdown(src: string): string {
  const html = md.parse(closeOpenFence(src), { async: false }) as string;
  return sanitizeHtml(html, OPTIONS);
}

/** 回复正文样式：站点没装 typography 插件，用任意变体补齐 */
export const chatProseClass =
  "break-words [&_p]:my-2 first:[&_p]:mt-0 last:[&_p]:mb-0 [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_a]:underline [&_a]:decoration-zinc-400 [&_a]:underline-offset-2 hover:[&_a]:decoration-current [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-500 dark:[&_blockquote]:border-zinc-600 dark:[&_blockquote]:text-zinc-400 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-900 dark:[&_pre]:bg-black/40 dark:[&_pre]:ring-1 dark:[&_pre]:ring-white/10 [&_pre]:p-3 [&_pre]:text-[13px] [&_pre]:leading-relaxed [&_pre]:text-zinc-100 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-zinc-100 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.9em] dark:[&_:not(pre)>code]:bg-zinc-800 [&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium [&_td]:px-2 [&_td]:py-1 [&_tr]:border-b [&_tr]:border-zinc-200/70 dark:[&_tr]:border-zinc-700/60 [&_hr]:my-3 [&_hr]:border-zinc-200 dark:[&_hr]:border-zinc-700";
