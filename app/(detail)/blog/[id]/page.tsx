import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { isAdmin } from "@/lib/auth";
import { getProfile } from "@/lib/profile-store";
import { getDiaryById, type Diary } from "@/lib/notion";
import { entrySummaryProseClass, renderMarkdown } from "@/lib/markdown";
import { summaryToPlainForCard } from "@/lib/share-card";

export const dynamic = "force-dynamic";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tengjun.org";

/** metadata 与页面共用同一次请求，避免各拉一次 Notion/Redis。 */
const getItem = cache((id: string) => getDiaryById(id));

function titleOf(item: Diary): string {
  const name = item.name?.trim();
  if (name) return name;
  const first = item.summary
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("!["));
  const clean = first
    ?.replace(/^#{1,6}\s*/, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean?.slice(0, 80) || "DailyRhapsody";
}

function descriptionOf(item: Diary): string {
  return summaryToPlainForCard(item.summary)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function imageUrl(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (/^https?:\/\//i.test(src)) return src;
  return `${siteUrl}${src.startsWith("/") ? src : `/${src}`}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const item = await getItem(id);
  if (!item) {
    return { title: "DailyRhapsody", robots: { index: false, follow: false } };
  }
  const admin = await isAdmin();
  if (!admin && item.isPublic === false) {
    return { title: "DailyRhapsody", robots: { index: false, follow: false } };
  }
  const title = titleOf(item);
  const description = descriptionOf(item);
  const canonical = `/blog/${item.id}`;
  const image = imageUrl(item.images?.[0]);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      type: "article",
      url: `${siteUrl}${canonical}`,
      siteName: "DailyRhapsody",
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
    },
  };
}

export default async function BlogEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = await getItem(id);
  if (!item) notFound();
  const admin = await isAdmin();
  if (!admin && item.isPublic === false) notFound();

  const profile = await getProfile().catch(() => null);
  const title = titleOf(item);
  const body = item.summary.replace(/^#\s+[^\n]*\n+/, "");
  const renderedHtml = renderMarkdown(body);
  const date = item.publishedAt?.slice(0, 10) || item.date;

  return (
    <div className="min-h-screen bg-white font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <header className="border-b border-zinc-200/80 dark:border-zinc-800/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-4 text-sm">
          <Link
            href="/blog"
            className="text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-400"
          >
            ← 返回博客
          </Link>
          <span className="text-zinc-400 dark:text-zinc-500">
            {profile?.name || "DailyRhapsody"}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{date}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h1>
        {(item.tags ?? []).length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {(item.tags ?? []).map((tag) => (
              <span
                key={tag}
                className="rounded bg-zinc-100 px-2 py-1 text-[0.7rem] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        <article
          className={`${entrySummaryProseClass(true)} mt-8 text-[0.95rem]`}
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      </main>
    </div>
  );
}
