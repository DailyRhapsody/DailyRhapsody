import type { MetadataRoute } from "next";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tengjun.org";

/**
 * 不再在 robots.txt 显式列出 /api/ 与 /admin/ —— 那等于给爬虫送地图。
 * 服务端已经在所有响应里加了 X-Robots-Tag: noindex, nofollow, noarchive，
 * 守规矩的搜索引擎照样不会索引；不守规矩的爬虫看到 disallow 反而当作"重点目标"。
 *
 * /reference 是例外：页面响应不写 noindex（见 proxy.ts 的 indexable 分支），
 * 所以这里允许抓取，并给出 sitemap。
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
