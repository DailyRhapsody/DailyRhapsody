import type { Metadata } from "next";
import { getProfile } from "@/lib/profile-store";
import { getCachedReferenceItems, isReferenceConfigured, type ReferenceItem } from "@/lib/notion-reference";
import ReferencePageClient from "./ReferencePageClient";

// app router 默认会缓存，但 dr_seed 必须随每次请求新签发，所以强制 dynamic
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Reference · 机器人行业资料库 | DailyRhapsody",
  description:
    "机器人领域的行业资料、竞品调研、实测报告与访谈，按类型、领域与机构归档，供同行检索与引用。",
  alternates: { canonical: "/reference" },
  openGraph: {
    title: "Reference · 机器人行业资料库",
    description:
      "机器人领域的行业资料、竞品调研、实测报告与访谈，按类型、领域与机构归档。",
    type: "website",
    locale: "zh_CN",
    siteName: "DailyRhapsody",
  },
  twitter: {
    card: "summary_large_image",
    title: "Reference · 机器人行业资料库",
    description: "机器人领域的行业资料、竞品调研、实测报告与访谈。",
  },
};

const PAGE_SIZE = 30;

function tagCountsOf(items: ReferenceItem[]): { name: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Server component：首屏直接读 Redis 缓存，把第一页塞进 HTML。
 * 只读缓存、不触发 Notion；缓存冷时交给客户端兜底拉取。
 */
export default async function ReferencePage() {
  let initialProfile = null;
  try {
    initialProfile = await getProfile();
  } catch {
    initialProfile = null;
  }

  let initialItems: ReferenceItem[] | undefined;
  let initialTotal: number | undefined;
  let initialTagCounts: { name: string; value: number }[] | undefined;

  if (isReferenceConfigured()) {
    try {
      const cached = await getCachedReferenceItems();
      if (cached) {
        const visible = cached.filter((item) => item.isPublic);
        initialItems = visible.slice(0, PAGE_SIZE);
        initialTotal = visible.length;
        initialTagCounts = tagCountsOf(visible);
      }
    } catch {
      // 缓存读不到：交给客户端挂载后走受保护的 /api/reference
    }
  }

  return (
    <ReferencePageClient
      initialProfile={initialProfile}
      initialItems={initialItems}
      initialTotal={initialTotal}
      initialTagCounts={initialTagCounts}
    />
  );
}
