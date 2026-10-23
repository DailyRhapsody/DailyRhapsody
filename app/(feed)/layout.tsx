import { getCachedDiaries } from "@/lib/notion";
import { getCachedMoments } from "@/lib/notion-moments";
import { getCachedReferenceItems } from "@/lib/notion-reference";
import { rankReferenceTop } from "@/lib/reference-ranking";
import { getLang } from "@/lib/i18n-server";
import { applyReferenceEn, getReferenceEnMap } from "@/lib/reference-i18n";
import { getProfile } from "@/lib/profile-store";
import { getReadingStats } from "@/lib/weread";
import { isAdmin } from "@/lib/auth";
import { countPostsByDate, countPostsInMonth } from "@/lib/post-activity";
import { visibleDiariesFor } from "@/lib/feed-stats";
import FeedShell, { type FeedStats } from "./FeedShell";

/**
 * /blog、/moments、/reference 的公共外壳。
 *
 * 这里只持 Header、顶部卡与卡片摘要值，不写 metadata、不写 route segment config：
 * 三个路由各自保留自己的 title/canonical/OG 与 force-dynamic，避免组级配置污染。
 * 摘要值读 Redis 缓存，不经过受 PoW 保护的页面 API；每个数据源独立兜底，
 * 某个源缺失只影响对应卡片，不阻断 children。
 */
export default async function FeedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let profile = null;
  try {
    profile = await getProfile();
  } catch {
    profile = null;
  }

  const bgmSrc =
    process.env.NEXT_PUBLIC_ENTRIES_BGM_SRC?.trim() || undefined;

  let readingStats = null;
  try {
    readingStats = await getReadingStats();
  } catch {
    readingStats = null;
  }

  let diaries = null;
  try {
    diaries = await getCachedDiaries();
  } catch {
    diaries = null;
  }
  /**
   * 查看者权限读一次 cookie：站长看到的篇数含私密，访客只含公开。
   * 首屏就要算对——参考 tab 不写回卡片数字（那里为空），一旦首屏给的是
   * 公开口径，站长会一直看到 276，直到切回博客 tab 才被客户端改成 280。
   * 取权限失败按访客处理，不让鉴权异常把整页打挂。
   */
  let admin = false;
  try {
    admin = await isAdmin();
  } catch {
    admin = false;
  }
  const visibleDiaries = visibleDiariesFor(diaries ?? [], admin);
  /** 热力图与「本月 N 篇更新」同源：按篇计数，同一天多篇不折叠成一天 */
  const dateCounts = countPostsByDate(visibleDiaries);
  const thisMonthPostCount = countPostsInMonth(dateCounts);

  let moments = null;
  try {
    moments = await getCachedMoments();
  } catch {
    moments = null;
  }
  const momentsThumbs: { src: string; isVideo: boolean }[] = [];
  for (const moment of moments ?? []) {
    if (!moment.isPublic) continue;
    for (const media of moment.media ?? []) {
      const src = (media.url || media.thumbUrl || "").trim();
      if (!src) continue;
      momentsThumbs.push({
        src,
        isVideo: (media.mediaType ?? "").startsWith("video/"),
      });
      if (momentsThumbs.length >= 4) break;
    }
    if (momentsThumbs.length >= 4) break;
  }

  let referenceTotal = 0;
  let referenceTop: { id: string; title: string }[] = [];
  try {
    const items = await getCachedReferenceItems();
    const publicItems = (items ?? []).filter((item) => item.isPublic);
    referenceTotal = publicItems.length;
    const lang = await getLang();
    const translations = lang === "en" ? await getReferenceEnMap() : null;
    const localized = translations
      ? publicItems.map((item) => applyReferenceEn(item, translations.get(item.id)))
      : publicItems;
    const ranked = await rankReferenceTop(localized);
    referenceTop = ranked.map(({ id }) => {
      const item = localized.find((candidate) => candidate.id === id);
      return {
        id,
        title: (lang === "en" ? item?.name : item?.titleZh?.trim() || item?.name) || "",
      };
    });
  } catch {
    referenceTotal = 0;
  }

  const initialStats: FeedStats = {
    totalPosts: visibleDiaries.length,
    thisMonthPostCount,
    dateCounts,
    momentsThumbs,
    referenceTotal,
    referenceTop,
  };

  return (
    <FeedShell
      profile={profile}
      bgmSrc={bgmSrc}
      readingStats={readingStats}
      initialStats={initialStats}
    >
      {children}
    </FeedShell>
  );
}
