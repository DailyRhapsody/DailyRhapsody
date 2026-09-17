import { splitBodyImages } from "@/components/entries/utils";
import type { EntryOutlineItem } from "@/components/entries/types";
import { stripHashtagOnlyLinesInProse } from "@/lib/hashtags";
import type { Diary } from "@/lib/notion";
import { summaryToPlainForCard } from "@/lib/share-card";

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_RE = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]+(?:['’.\-][\p{Script=Latin}\p{N}]+)*/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * 读者看得到的文字量：汉字/假名/韩文按字计，拉丁字母与数字按词计，emoji 按个计。
 * 不计图片、整行 #标签、代码块（含 mermaid）、链接地址、HTML 标签和裸 URL。
 */
export function countEntryWords(summary: string): number {
  const prose = stripHashtagOnlyLinesInProse(splitBodyImages(summary ?? "").text);
  const plain = summaryToPlainForCard(prose)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  return (
    (plain.match(CJK_RE)?.length ?? 0) +
    (plain.replace(CJK_RE, " ").match(WORD_RE)?.length ?? 0) +
    (plain.match(EMOJI_RE)?.length ?? 0)
  );
}

/** list 必须是已按访客权限、tag、搜索词过滤后的列表，顺序与分页一致 */
export function buildEntryOutline(list: Diary[]): EntryOutlineItem[] {
  return list.map((d) => ({
    id: d.id,
    at: d.publishedAt ?? `${d.date}T12:00:00`,
    words: countEntryWords(d.summary),
    ...(d.isPublic === false ? { isPublic: false as const } : {}),
    ...(d.pinned ? { pinned: true as const } : {}),
  }));
}
