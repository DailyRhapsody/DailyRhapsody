import { getProfile } from "@/lib/profile-store";
import EntriesPageClient from "./EntriesPageClient";

/**
 * /blog 与 /moments 共用这一页（/moments 由 next.config.ts 重写到 /blog），
 * 显示哪个 tab 由客户端按地址决定，两个 tab 之间切换不重载页面。
 *
 * Server component: 预取 profile 后再把结果作为 initialProfile 下传给客户端组件，
 * 避免首帧 profile===null 时 StickyProfileHeader 走居中兜底 → 数据到达后跳到左对齐。
 *
 * 微信读书阅读数据同样在服务端预取：它是只读 Redis 缓存，不带 API Key 进浏览器，
 * 也不需要新增公开路由与 proxy matcher 条目。缓存由每日 Cron 预热。
 */
export default async function EntriesPage() {
  let initialProfile = null;
  try {
    initialProfile = await getProfile();
  } catch {
    initialProfile = null;
  }

  return <EntriesPageClient initialProfile={initialProfile} />;
}
