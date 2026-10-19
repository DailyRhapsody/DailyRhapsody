import { getCachedDiaries } from "@/lib/notion";
import { getCachedMoments } from "@/lib/notion-moments";
import { getCachedReferenceItems } from "@/lib/notion-reference";
import { pickReferenceTop } from "@/lib/reference-thumbs";
import { getProfile } from "@/lib/profile-store";
import { getReadingStats } from "@/lib/weread";
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
  const publicDiaries = (diaries ?? []).filter((d) => d.isPublic !== false);
  const dates = [...new Set(publicDiaries.map((d) => d.date).filter(Boolean))];
  const monthKey = new Date().toISOString().slice(0, 7);
  const thisMonthPostCount = dates.filter((d) => d.slice(0, 7) === monthKey).length;

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
    referenceTop = pickReferenceTop(publicItems);
  } catch {
    referenceTotal = 0;
  }

  const initialStats: FeedStats = {
    totalPosts: publicDiaries.length,
    thisMonthPostCount,
    dates,
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
