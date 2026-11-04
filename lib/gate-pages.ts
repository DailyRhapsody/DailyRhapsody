/**
 * 会签发 dr_seed 的页面：页面 GET 时 proxy 随响应下发 seed，握手不必再现取。
 * 其他页面上握手会先向 /api/gate/seed 现取一张（lib/gate-handshake.ts），同样能完成。
 * proxy.ts 与右下角宠物共用这一份清单，增删页面时两边不会不同步。
 */
export function isGateIssuingPath(pathname: string): boolean {
  if (pathname === "/reference") return true;
  // 只认条目页，别把 /reference/opengraph-image 这类静态衍生路由也塞进 gate，
  // 否则分享图会被打上 no-store 并下发一个无关的 dr_seed cookie。
  if (/^\/reference\/[0-9a-f]{32}$/i.test(pathname)) return true;
  if (/^\/reference\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(pathname)) return true;
  // 单篇文章页（分享链接的落地页）：正文在握手完成后才从 /api/diaries/[id] 读取。
  // 不在这里签发种子，从链接直接进来的访客没有 dr_seed、做不了握手，正文永远 403。
  if (/^\/blog\/(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.test(pathname)) return true;
  return (
    pathname === "/" ||
    pathname === "/blog" ||
    pathname === "/moments" ||
    pathname === "/about"
  );
}
