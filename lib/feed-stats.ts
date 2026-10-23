import type { Diary } from "./notion";

/**
 * 顶部卡片、热力图与 `/api/diaries` 共用的可见性口径：站长看全部，访客只看公开。
 *
 * 为什么共享 layout 首屏也要用它：卡片数字原先只由客户端在博客、动态两个 tab 上写回，
 * 参考 tab 为了避免参考页首帧的空数据而跳过写入（见 EntriesPageClient 的上报条件）。
 * 于是以整页加载的方式进入参考页时，卡片会长期停在公开篇数——站长登录后看到的 276
 * 与列表、接口给出的 280 对不上，切回博客 tab 之前不会自愈。
 *
 * 日记库的 `isPublic` 缺省按公开处理（与历史 `isPublic !== false` 一致）；动态库与
 * 资料库的缺省不同，不要在那些地方套用这个函数。
 */
export function visibleDiariesFor(diaries: Diary[], admin: boolean): Diary[] {
  return admin ? diaries : diaries.filter((d) => d.isPublic !== false);
}

/**
 * 客户端是否可以把自己那份博客统计写回顶部卡片。
 *
 * 参考 tab 一律不写：那个路由不展示博客统计，参考页首帧的 total 恒为 0，写回会把卡片刷成 0。
 * 首屏尚未成功落地也不写：`loading` 期间以及首次成功之前的 total 同样是 0，但那不代表
 * 「真的没有文章」。用 `firstPageLoaded`（只在 2xx 首屏响应后置真）区分，既挡住失败那一帧，
 * 也让真实的 0 篇能正常写回。
 */
export function shouldPublishEntryStats({
  activeTopTab,
  loading,
  firstPageLoaded,
}: {
  activeTopTab: number;
  loading: boolean;
  firstPageLoaded: boolean;
}): boolean {
  if (activeTopTab === 2) return false;
  return !loading && firstPageLoaded;
}
