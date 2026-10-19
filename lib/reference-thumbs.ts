/**
 * 顶部参考卡的四格封面。
 * 有 Notion Cover 用 Cover；没有封面时退回来源站点 favicon，
 * 避免资料区四格全白。只用于展示，不写入 Notion。
 */
export function referenceThumbSrc(item: {
  coverPath: string | null;
  url: string;
}): string | null {
  if (item.coverPath) return item.coverPath;
  try {
    const host = new URL(item.url).hostname;
    if (!host) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
  } catch {
    return null;
  }
}

/** 同一条资料重复入库时，顶部四格只取一次，避免四格显示同一个来源图。 */
export function pickReferenceThumbs(
  items: { coverPath: string | null; url: string; id: string }[],
  max = 4,
): { src: string; isVideo: boolean }[] {
  const seen = new Set<string>();
  const out: { src: string; isVideo: boolean }[] = [];
  for (const item of items) {
    const key = item.url || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const src = referenceThumbSrc(item);
    if (!src) continue;
    out.push({ src, isVideo: false });
    if (out.length >= max) break;
  }
  return out;
}

/** 顶部参考卡的文字榜单：优先中文标题，标题去重。 */
export function pickReferenceTop(
  items: { id: string; name: string; titleZh?: string | null; url: string }[],
  max = 6,
): { id: string; title: string }[] {
  const seen = new Set<string>();
  const out: { id: string; title: string }[] = [];
  for (const item of items) {
    const key = item.url || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = (item.titleZh?.trim() || item.name.trim());
    if (!title) continue;
    out.push({ id: item.id, title });
    if (out.length >= max) break;
  }
  return out;
}
