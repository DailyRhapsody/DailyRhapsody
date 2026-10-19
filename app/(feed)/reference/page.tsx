import type { Metadata } from "next";
import { getCachedReferenceItems, getReferenceItems, isReferenceConfigured, type ReferenceItem } from "@/lib/notion-reference";
import { getProfile } from "@/lib/profile-store";
import EntriesPageClient from "../blog/EntriesPageClient";

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
    images: [
      {
        url: "/reference/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Reference · 机器人行业资料库",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Reference · 机器人行业资料库",
    description: "机器人领域的行业资料、竞品调研、实测报告与访谈。",
    images: ["/reference/opengraph-image"],
  },
};

const PAGE_SIZE = 200;

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
      // 缓存冷时必须回源一次：可索引页面如果只输出空态，爬虫看到的就是空页，
      // 而客户端 /api/reference 又要过 PoW，爬虫不会跑。
      const cached = (await getCachedReferenceItems()) ?? (await getReferenceItems());
      const visible = cached.filter((item) => item.isPublic);
      initialItems = visible.slice(0, PAGE_SIZE);
      initialTotal = visible.length;
      initialTagCounts = tagCountsOf(visible);
    } catch {
      // Notion 限流/未配置：交给客户端挂载后走受保护的 /api/reference
    }
  }

  return (
    <EntriesPageClient
      initialProfile={initialProfile}
      initialReferenceItems={initialItems}
      initialReferenceTotal={initialTotal}
      initialReferenceTagCounts={initialTagCounts}
    />
  );
}
