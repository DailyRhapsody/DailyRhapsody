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
