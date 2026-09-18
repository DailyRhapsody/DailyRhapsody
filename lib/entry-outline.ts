import { splitBodyImages } from "@/components/entries/utils";
import type { EntryOutlineItem } from "@/components/entries/types";
import { stripHashtagOnlyLinesInProse } from "@/lib/hashtags";
import type { Diary } from "@/lib/notion";
import { summaryToPlainForCard } from "@/lib/share-card";

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_RE = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]+(?:['’.\-][\p{Script=Latin}\p{N}]+)*/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

const EXCERPT_CHARS = 10;

/** 读者看得到的正文文字：去掉图片、整行 #标签、代码块（含 mermaid）、链接地址、HTML 标签和裸 URL */
function entryPlainText(summary: string): string {
  const prose = stripHashtagOnlyLinesInProse(splitBodyImages(summary ?? "").text);
  return summaryToPlainForCard(prose)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/** 汉字/假名/韩文按字计，拉丁字母与数字按词计，emoji 按个计 */
export function countEntryWords(summary: string): number {
  return countPlainWords(entryPlainText(summary));
}

function countPlainWords(plain: string): number {
  return (
    (plain.match(CJK_RE)?.length ?? 0) +
    (plain.replace(CJK_RE, " ").match(WORD_RE)?.length ?? 0) +
    (plain.match(EMOJI_RE)?.length ?? 0)
  );
}

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** 正文前 10 个字（按字形计，emoji 不拆开；空白折叠），超出时以「…」结尾 */
function excerptOf(plain: string): string {
  const chars = Array.from(graphemes.segment(plain.replace(/\s+/g, " ").trim()), (g) => g.segment);
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join("").trimEnd()}…` : chars.join("");
}

/** list 必须是已按访客权限、tag、搜索词过滤后的列表，顺序与分页一致 */
export function buildEntryOutline(list: Diary[]): EntryOutlineItem[] {
  return list.map((d) => {
    const plain = entryPlainText(d.summary);
    const excerpt = excerptOf(plain);
    return {
      id: d.id,
      at: d.publishedAt ?? `${d.date}T12:00:00`,
      words: countPlainWords(plain),
      ...(excerpt ? { excerpt } : {}),
      ...(d.isPublic === false ? { isPublic: false as const } : {}),
      ...(d.pinned ? { pinned: true as const } : {}),
    };
  });
}
