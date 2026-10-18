/** 全站 HTTP 安全响应头（由 next.config 与需要时下发给 API）。
 *
 * X-Robots-Tag 不在这里：/reference 需要被搜索引擎收录，而 next.config 的
 * headers() 是路径级的、无法按请求动态放行。统一由 proxy.ts 的
 * withAntiScrapeHeaders 设置；页面与 API 都在 matcher 内，行为不变。
 */
export const httpSecurityHeaders: { key: string; value: string }[] = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self)",
  },
];

export function hstsHeader(): { key: string; value: string } | null {
  if (process.env.NODE_ENV !== "production") return null;
  return {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  };
}

export function allHttpSecurityHeaders(): { key: string; value: string }[] {
  const hsts = hstsHeader();
  return hsts ? [...httpSecurityHeaders, hsts] : [...httpSecurityHeaders];
}
