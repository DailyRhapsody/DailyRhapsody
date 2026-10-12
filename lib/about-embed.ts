/**
 * 判断一个响应是否允许本站把它放进 iframe。
 *
 * 抽成纯函数的原因：真实响应头会随 Notion / Cloudflare 的限流变化（实测连续请求会拿到
 * 429，且 429 自带 X-Frame-Options: SAMEORIGIN），拿网络结果直接断言会把限流误判成
 * 「端点已收口」。分类逻辑单独可测，网络只负责取回 status 与两个头。
 */
export function isEmbeddable(
  status: number,
  xFrameOptions: string | null,
  contentSecurityPolicy: string
): boolean {
  // 非 200（429 限流、5xx、403）一律按不可用处理，宁可多显示兜底
  if (status !== 200) return false;
  // 只要下发 X-Frame-Options，浏览器就会拒绝渲染
  if (xFrameOptions) return false;

  const ancestors = /frame-ancestors\s+([^;]+)/i.exec(contentSecurityPolicy);
  // 没有 frame-ancestors 指令时，CSP 不限制被嵌来源
  if (!ancestors) return true;

  const list = ancestors[1].trim().toLowerCase();
  // 必须按空格切词后整词比较：`https://app.notion.com` 含子串 `https:`，
  // 用 includes 会把「只允许 app.notion.com」误判成放行。
  return list
    .split(/\s+/)
    .filter(Boolean)
    .some((source) => source === "https:" || source === "http:" || source === "*");
}
