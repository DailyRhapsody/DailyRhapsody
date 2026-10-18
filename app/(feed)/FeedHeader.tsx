"use client";

import { usePathname } from "next/navigation";
import StickyProfileHeader, {
  type StickyProfileHeaderData,
} from "@/components/StickyProfileHeader";

/**
 * 列表页共用的粘性顶栏。
 * Header 本身挂在 (feed) layout 上，跨 /blog、/moments、/reference 不重挂载；
 * BGM 只在内容流页启用，进入资料库时卸下 audio，避免资料库突然出声。
 */
export default function FeedHeader({
  profile,
  bgmSrc,
  className,
}: {
  profile: StickyProfileHeaderData | null;
  bgmSrc?: string;
  className?: string;
}) {
  const pathname = usePathname();
  const isContentFeed = pathname === "/blog" || pathname === "/moments";
  return (
    <StickyProfileHeader
      profile={profile}
      entriesBgmSrc={isContentFeed ? bgmSrc : undefined}
      className={className}
    />
  );
}
