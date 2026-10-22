export const PAGE_SIZE = 30;
export const MAX_SUMMARY_LINES = 5;

export function momentsGridClass(n: number) {
  if (n <= 1) return "grid-cols-1";
  if (n <= 4) return "grid-cols-2";
  return "grid-cols-3";
}

export { momentsGridClass as galleryGridClass };

/** 独占一行的 markdown 图片：`![alt](url)` 或 `![alt](url "title")`，url 允许一层成对括号 */
const STANDALONE_IMAGE_LINE =
  /^[ \t]*!\[[^\]\n]*\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+"[^"\n]*")?\s*\)[ \t]*$/;
const FENCED_CODE = /(`{3,})[\s\S]*?\1/g;

/**
 * 提取正文里独占一行的图片，供分享卡取纯文本与目录提取跳过图片行。
 * 列表卡顶部只展示 Notion 的 Image 字段；正文图片仍按 Markdown 原位置渲染。
 */
export function splitBodyImages(summary: string): { text: string; images: string[] } {
  const images: string[] = [];
  const strip = (segment: string) => {
    const lines = segment.split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = STANDALONE_IMAGE_LINE.exec(lines[i]);
      if (!m) {
        kept.push(lines[i]);
        continue;
      }
      images.push(m[1]);
      // block 之间用一个空行连接：图片后面有空行就连它一起删，末尾的图片则删前面那个
      if (lines[i + 1] === "") i++;
      else if (i === lines.length - 1 && kept.at(-1) === "") kept.pop();
    }
    return kept.join("\n");
  };
  let text = "";
  let last = 0;
  for (const m of summary.matchAll(FENCED_CODE)) {
    const start = m.index ?? 0;
    text += strip(summary.slice(last, start)) + m[0];
    last = start + m[0].length;
  }
  text += strip(summary.slice(last));
  if (images.length === 0) return { text: summary, images };
  // 只去首尾换行：trim() 会连首段开头的全角空格缩进一起删掉
  return { text: text.replace(/^\n+|\n+$/g, ""), images };
}

export function legacyCopyTextToClipboard(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function getSizeClass(count: number, maxCount: number) {
  if (maxCount <= 0) return "text-xs";
  const r = count / maxCount;
  if (r >= 0.7) return "text-base sm:text-lg";
  if (r >= 0.4) return "text-sm sm:text-base";
  if (r >= 0.2) return "text-xs sm:text-sm";
  return "text-[0.65rem] sm:text-xs";
}
