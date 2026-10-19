import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { isAdmin } from "@/lib/auth";
import {
  getReferenceItem,
  isReferenceConfigured,
  type ReferenceItem,
} from "@/lib/notion-reference";
import { referenceLicenseLabel } from "@/lib/reference-taxonomy";
import { getLang } from "@/lib/i18n-server";
import { applyReferenceEn, getReferenceEnMap } from "@/lib/reference-i18n";
import { t, type Lang } from "@/lib/i18n";
import type { ReferenceCompanyProfile } from "@/lib/reference-profile";
import { recordReferenceView } from "@/lib/reference-ranking";
import { renderMarkdown, markdownHeadingClass, markdownPreviewProseClass } from "@/lib/markdown";
import { ReferenceLikeButton } from "@/components/reference/ReferenceLikeButton";
import { ReferenceShareButton } from "@/components/reference/ReferenceShareButton";

export const dynamic = "force-dynamic";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tengjun.org";

/** metadata 与页面共用同一次请求，避免各拉一次 Notion/Redis */
const getItem = cache((id: string) => getReferenceItem(id));

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 中文页优先内容标题；英文页优先原文名，缺失时回落到中文标题。 */
function displayTitle(item: ReferenceItem, lang: Lang): string {
  if (lang === "zh") return item.titleZh?.trim() || item.name || "";
  return item.name || item.titleZh?.trim() || "";
}

function descriptionOf(item: ReferenceItem): string {
  return item.summary || item.copyright || "DailyRhapsody Reference";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!isReferenceConfigured()) {
    return { title: "Reference | DailyRhapsody", robots: { index: false, follow: false } };
  }
  const item = await getItem(id);
  const admin = await isAdmin();
  // 私密条目不把标题/摘要泄给爬虫与分享卡片
  if (!item || (!admin && !item.isPublic)) {
    return { title: "Reference | DailyRhapsody", robots: { index: false, follow: false } };
  }

  const lang = await getLang();
  const translated =
    lang === "en"
      ? applyReferenceEn(item, (await getReferenceEnMap()).get(item.id))
      : item;
  const title = displayTitle(translated, lang) || "Reference";
  const description = descriptionOf(translated);

  return {
    title: `${title} · Reference | DailyRhapsody`,
    description,
    alternates: { canonical: `/reference/${item.id}` },
    openGraph: {
      title,
      description,
      type: "article",
      locale: lang === "en" ? "en_US" : "zh_CN",
      siteName: "DailyRhapsody",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

/**
 * 只保留判断「这家公司是谁、做什么」必需的字段。
 * 产品线、技术、创始人、资本与竞争等信息放在正文档案里，避免页头堆成表格。
 */
function CompanyFacts({ profile, lang }: { profile: ReferenceCompanyProfile; lang: Lang }) {
  const facts: { label: string; value: string }[] = [
    {
      label: t(lang, "company.headcount"),
      value: profile.headcount != null ? String(profile.headcount) : "",
    },
    { label: t(lang, "company.scenarios"), value: profile.scenarios.join(" · ") },
    { label: t(lang, "company.products"), value: profile.productForms.join(" · ") },
    { label: t(lang, "company.markets"), value: profile.markets.join(" · ") },
  ].filter((fact) => fact.value);

  if (facts.length === 0) return null;

  return (
    <dl
      aria-label={t(lang, "company.heading")}
      className="mt-5 grid grid-cols-1 gap-x-8 gap-y-1.5 border-t border-zinc-200 pt-4 text-xs sm:grid-cols-2 dark:border-zinc-800"
    >
      {facts.map((fact) => (
        <div key={fact.label} className="flex min-w-0 gap-2">
          <dt className="shrink-0 text-zinc-400 dark:text-zinc-500">{fact.label}</dt>
          <dd className="min-w-0 break-words text-zinc-700 dark:text-zinc-300">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function ReferenceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isReferenceConfigured()) notFound();
  const { id } = await params;
  let item = await getItem(id);
  if (!item) notFound();
  const admin = await isAdmin();
  if (!admin && !item.isPublic) notFound();
  if (item.isPublic) await recordReferenceView(item.id);
  const lang = await getLang();
  if (lang === "en") {
    const translations = await getReferenceEnMap();
    item = applyReferenceEn(item, translations.get(item.id));
  }

  const title = displayTitle(item, lang);
  const sourceLabel = hostnameOf(item.url) || (item.source && item.source !== "手动添加" ? item.source : "");
  const renderedHtml = item.bodyMarkdown ? renderMarkdown(item.bodyMarkdown) : "";
  const canDownload = item.license !== "link-only" && item.attachment != null;

  const jsonLd = item.isPublic
    ? {
        "@context": "https://schema.org",
        "@type": item.kind === "test" ? "Report" : "Article",
        headline: title,
        description: item.summary || undefined,
        url: `${siteUrl}/reference/${item.id}`,
        ...(item.coverPath
          ? {
              image:
                item.coverKind === "external"
                  ? item.coverPath
                  : `${siteUrl}${item.coverPath}`,
            }
          : {}),
        inLanguage: lang === "en" ? "en" : "zh-CN",
        isPartOf: {
          "@type": "CollectionPage",
          name: "DailyRhapsody Reference",
          url: `${siteUrl}/reference`,
        },
      }
    : null;

  return (
    <div className="min-h-screen bg-white font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      {jsonLd && (
        <script
          type="application/ld+json"
          // 防止正文标题里的 </script> 提前闭合
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      )}

      <div className="sticky top-0 z-30 border-b border-zinc-200/80 bg-white/85 backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-950/85">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-3 text-sm">
          <Link
            href="/reference"
            className="rounded text-zinc-600 transition-colors hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            ← {t(lang, "reference.detail.back")}
          </Link>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-500 transition-colors hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {t(lang, "reference.detail.jump")} ↗
            </a>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-5 py-8 sm:py-10">
        <header>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            {t(lang, "reference.detail.collected")} {formatDate(item.clippedAt)}
          </p>
          <h1 className="mt-2 text-3xl font-semibold leading-[1.2] tracking-tight text-zinc-900 sm:text-[2.1rem] dark:text-zinc-50">
            {title || t(lang, "reference.card.untitled")}
          </h1>

          {item.summary && (
            <p className="mt-3 max-w-2xl text-[0.95rem] leading-relaxed text-zinc-600 dark:text-zinc-300">
              {item.summary}
            </p>
          )}

          {item.company ? <CompanyFacts profile={item.company} lang={lang} /> : null}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {canDownload && (
              <a
                href={`/api/download/reference/${item.id}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-sm text-white transition-apple hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {t(lang, "reference.detail.download")}
                {item.attachment?.kind === "external" ? " ↗" : ""}
              </a>
            )}
            <ReferenceLikeButton id={item.id} />
            <ReferenceShareButton title={title || "Reference"} text={item.summary} />
          </div>
        </header>

        {renderedHtml ? (
          <article
            className={`${markdownPreviewProseClass} ${markdownHeadingClass} mt-8 border-t border-zinc-200 pt-7 text-[0.95rem] leading-relaxed dark:border-zinc-800`}
          >
            <div className="space-y-[1.15em]" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </article>
        ) : (
          <p className="mt-8 border-t border-zinc-200 pt-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {t(lang, "reference.detail.emptyBody")}
            {item.url && (
              <>
                {" "}
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
                >
                  {t(lang, "reference.detail.jumpRead")} ↗
                </a>
              </>
            )}
          </p>
        )}

        <footer className="mt-10 border-t border-zinc-200 pt-4 text-[0.7rem] leading-relaxed text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          {sourceLabel && <span>{sourceLabel} · </span>}
          <span>{referenceLicenseLabel(item.license, lang)}</span>
          {item.copyright ? <span> · {item.copyright}</span> : null}
        </footer>
      </main>
    </div>
  );
}
