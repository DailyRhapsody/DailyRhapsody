/**
 * 会签发 dr_seed 的页面。只有在这些页面上 GateClient 才能完成握手，
 * 受保护接口（含 AI-Persona 对话）才请求得通。proxy.ts 与右下角宠物共用这一份清单，
 * 增删页面时两边不会不同步。
 */
export function isGateIssuingPath(pathname: string): boolean {
  if (pathname === "/reference") return true;
  // 只认条目页，别把 /reference/opengraph-image 这类静态衍生路由也塞进 gate，
  // 否则分享图会被打上 no-store 并下发一个无关的 dr_seed cookie。
  if (/^\/reference\/[0-9a-f]{32}$/i.test(pathname)) return true;
  if (/^\/reference\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(pathname)) return true;
  return (
    pathname === "/" ||
    pathname === "/blog" ||
    pathname === "/moments" ||
    pathname === "/about"
  );
}
