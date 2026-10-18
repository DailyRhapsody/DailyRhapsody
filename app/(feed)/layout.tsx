import { getProfile } from "@/lib/profile-store";
import FeedHeader from "./FeedHeader";

/**
 * /blog、/moments、/reference 的公共外壳。
 *
 * 这里只持 Header，不写 metadata、不写 route segment config：
 * 三个路由各自保留自己的 title/canonical/OG 与 force-dynamic，避免组级配置污染。
 * 外层容器同时包住 Header 与 children，sticky 才有足够的包含块高度。
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

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col">
      <FeedHeader profile={profile} bgmSrc={bgmSrc} />
      {children}
    </div>
  );
}
