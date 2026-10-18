import type { MetadataRoute } from "next";
import { getCachedReferenceItems, isReferenceConfigured } from "@/lib/notion-reference";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tengjun.org";

// 条目来自 Redis 缓存，不能在建站时就固化；每次请求重新生成。
export const dynamic = "force-dynamic";

/**
 * 只列可公开索引的页面：首页、博客、Reference 列表与公开条目。
 * 不碰 /api/*、/admin/*、私密条目。
 * 只读缓存，不在 sitemap 请求里回源 Notion；缓存冷时先返回静态页。
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/`, changeFrequency: "daily", priority: 1 },
    { url: `${siteUrl}/blog`, changeFrequency: "daily", priority: 0.8 },
    { url: `${siteUrl}/reference`, changeFrequency: "daily", priority: 0.9 },
  ];

  if (!isReferenceConfigured()) return base;

  try {
    const items = (await getCachedReferenceItems()) ?? [];
    return [
      ...base,
      ...items
        .filter((item) => item.isPublic && !Number.isNaN(new Date(item.clippedAt).getTime()))
        .map((item) => ({
          url: `${siteUrl}/reference/${item.id}`,
          lastModified: new Date(item.clippedAt),
          changeFrequency: "monthly" as const,
          priority: 0.6,
        })),
    ];
  } catch {
    return base;
  }
}
