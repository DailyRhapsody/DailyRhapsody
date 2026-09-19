/**
 * 会签发 dr_seed 的页面。只有在这些页面上 GateClient 才能完成握手，
 * 受保护接口（含数字人对话）才请求得通。proxy.ts 与右下角宠物共用这一份清单，
 * 增删页面时两边不会不同步。
 */
export function isGateIssuingPath(pathname: string): boolean {
  if (pathname.startsWith("/reference")) return true;
  return (
    pathname === "/" ||
    pathname === "/entries" ||
    pathname === "/the-moment" ||
    pathname === "/about"
  );
}
