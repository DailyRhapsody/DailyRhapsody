/**
 * Notion page id 的两种写法：带连字符（36）与纯 32 位 hex。
 * 站内路由用带连字符的 page.id；媒体代理路径会去掉连字符。
 * 任何需要跨这两条路径查缓存的逻辑都必须先规范化，否则同一条目会被当成两条。
 */

const HEX32 = /^[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function isReferencePageId(id: string): boolean {
  return HEX32.test(id) || UUID.test(id);
}

/** 统一成 Notion API 的带连字符写法；不是合法 id 时原样返回。 */
export function canonicalReferenceId(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!HEX32.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
