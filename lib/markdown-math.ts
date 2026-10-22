import katex from "katex";

/**
 * Markdown 数学公式保护层。
 *
 * 为什么不在 marked 的 renderer 里直接输出 KaTeX HTML：
 * marked 的 postprocess 会调用 sanitize-html，KaTeX 的 <math>/<span style> 会被
 * 当成不安全标签剥掉，公式只剩一堆错位的字符。这里先把公式换成普通 span/div
 * 占位符（只含 class 和纯文本 token，能通过 sanitize），等 sanitize 结束后再
 * 替换成 KaTeX 输出。
 *
 * 代码块与行内代码里的 `$` 必须原样保留：先扫描并跳过 fence / 反引号片段，
 * 再做公式识别。
 */

type MathReplacement = {
  token: string;
  html: string;
  block: boolean;
};

const TOKEN_PREFIX = "DRMATHPLACEHOLDER";
const TOKEN_SUFFIX = "END";

function renderMath(expression: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expression, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
    });
  } catch {
    // 极端情况下 KaTeX 自己抛错，保留原文比让整篇文章渲染失败好。
    return `<code>${escapeHtml(expression)}</code>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function countRun(source: string, start: number, char: string): number {
  let i = start;
  while (source[i] === char) i++;
  return i - start;
}

function findRun(source: string, start: number, char: string, length: number): number {
  let i = start;
  while (i < source.length) {
    if (source[i] === char) {
      const run = countRun(source, i, char);
      if (run === length) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

function findUnescaped(source: string, needle: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const found = source.indexOf(needle, i);
    if (found === -1) return -1;
    if (!isEscaped(source, found)) return found;
    i = found + needle.length;
  }
  return -1;
}

function findInlineClose(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    if (source[i] === "\n") return -1;
    if (source[i] === "$" && !isEscaped(source, i)) {
      if (source[i + 1] !== "$") return i;
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * 把公式替换成占位符。返回的 markdown 仍保留原始代码块/行内代码。
 */
export function protectMath(source: string): {
  markdown: string;
  replacements: MathReplacement[];
} {
  const replacements: MathReplacement[] = [];
  let out = "";
  let i = 0;
  let lineStart = true;

  const pushReplacement = (expression: string, block: boolean) => {
    const index = replacements.length;
    const token = `${TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`;
    replacements.push({ token, html: renderMath(expression, block), block });
    // 占位符必须是纯文本：highlightHashtagsForRender 会转义 HTML，
    // 带 <span> 的占位符会被打成 &lt;span&gt;，公式就露在页面上了。
    return block ? `\n\n${token}\n\n` : token;
  };

  while (i < source.length) {
    // 围栏代码块：整段原样保留，里面的 $ 和反引号都不参与公式/代码识别。
    if (lineStart) {
      const fence = source.slice(i).match(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/);
      if (fence) {
        const marker = fence[1];
        const bodyStart = i + fence[0].length;
        const rest = source.slice(bodyStart);
        const close = new RegExp(
          `(?:^|\\n) {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)`
        ).exec(rest);
        const end = close ? bodyStart + close.index + close[0].length : source.length;
        out += source.slice(i, end);
        i = end;
        lineStart = i > 0 && source[i - 1] === "\n";
        continue;
      }
    }

    // 行内代码：整段原样保留。
    if (source[i] === "`") {
      const run = countRun(source, i, "`");
      const close = findRun(source, i + run, "`", run);
      if (close !== -1) {
        const end = close + run;
        out += source.slice(i, end);
        i = end;
        lineStart = source[i - 1] === "\n";
        continue;
      }
      out += source.slice(i, i + run);
      i += run;
      lineStart = false;
      continue;
    }

    // 块公式 $$...$$
    if (source[i] === "$" && source[i + 1] === "$" && !isEscaped(source, i)) {
      const close = findUnescaped(source, "$$", i + 2);
      if (close !== -1) {
        const expression = source.slice(i + 2, close).trim();
        if (expression) {
          out += pushReplacement(expression, true);
          i = close + 2;
          lineStart = false;
          continue;
        }
      }
    }

    // 行内公式 $...$；纯货币（$123 / $1,234）不当公式。
    if (source[i] === "$" && source[i + 1] !== "$" && !isEscaped(source, i)) {
      const close = findInlineClose(source, i + 1);
      if (close !== -1) {
        const expression = source.slice(i + 1, close);
        const trimmed = expression.trim();
        if (trimmed && !/^\d+(?:[.,]\d+)?$/.test(trimmed)) {
          out += pushReplacement(trimmed, false);
          i = close + 1;
          lineStart = false;
          continue;
        }
      }
    }

    const char = source[i];
    out += char;
    lineStart = char === "\n";
    i++;
  }

  return { markdown: out, replacements };
}

/** sanitize 之后把占位符换回 KaTeX HTML。 */
export function restoreMath(html: string, replacements: MathReplacement[]): string {
  let out = html;
  for (const { token, html: replacement, block } of replacements) {
    if (block) {
      const paragraph = new RegExp(`<p>\\s*${token}\\s*</p>`, "g");
      if (out.search(paragraph) !== -1) {
        out = out.replace(paragraph, `<div class="dr-math-block">${replacement}</div>`);
        continue;
      }
    }
    // 行内公式在段落、表格单元格里都只是普通文本 token；块公式如果没有
    // 独占成段，也至少不要让 token 泄漏到页面。
    out = out.replaceAll(token, replacement);
  }
  return out;
}
