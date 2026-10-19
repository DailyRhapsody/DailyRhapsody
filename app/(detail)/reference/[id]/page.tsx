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
import {
  referenceKindLabel,
  referenceLicenseLabel,
} from "@/lib/reference-taxonomy";
import { getLang } from "@/lib/i18n-server";
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

function descriptionOf(item: ReferenceItem): string {
  return (
    item.summary ||
    item.copyright ||
    `DailyRhapsody Reference 收录：${item.name || "未命名条目"}`
  );
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

  const description = descriptionOf(item);
  return {
    title: `${item.name || "Reference"} · Reference | DailyRhapsody`,
    description,
    alternates: { canonical: `/reference/${item.id}` },
    openGraph: {
      title: item.name || "Reference",
      description,
      type: "article",
      locale: "zh_CN",
      siteName: "DailyRhapsody",
    },
    twitter: {
      card: "summary_large_image",
      title: item.name || "Reference",
      description,
    },
  };
}

function CompanyProfileBlock({ profile, lang }: { profile: ReferenceCompanyProfile; lang: Lang }) {
  const rows: { label: string; value: string }[] = [
    { label: t(lang, "company.name"), value: profile.companyName },
    { label: t(lang, "company.headcount"), value: profile.headcount != null ? String(profile.headcount) : "" },
    { label: t(lang, "company.scenarios"), value: profile.scenarios.join(" · ") },
    { label: t(lang, "company.products"), value: profile.productForms.join(" · ") },
    { label: t(lang, "company.culture"), value: profile.operationCulture },
    { label: t(lang, "company.markets"), value: profile.markets.join(" · ") },
    { label: t(lang, "company.tags"), value: profile.companyTags.join(" · ") },
    { label: t(lang, "company.sales"), value: profile.salesModes.join(" · ") },
    { label: t(lang, "company.listed"), value: profile.listed },
    { label: t(lang, "company.profitability"), value: profile.profitability },
    { label: t(lang, "company.interview"), value: profile.interviewStatus },
  ].filter((row) => row.value);

  if (rows.length === 0) return null;
  return (
    <section className="mt-6 border-t border-zinc-200 pt-5 dark:border-zinc-800">
      <h2 className="text-[0.68rem] font-medium uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-500">
        {t(lang, "company.heading")}
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-xs sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex min-w-0 gap-3">
            <dt className="min-w-[4.5rem] shrink-0 whitespace-nowrap text-zinc-400 dark:text-zinc-500">{row.label}</dt>
            <dd className="min-w-0 break-words text-zinc-700 dark:text-zinc-300">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function InfoBlock({ item, lang }: { item: ReferenceItem; lang: Lang }) {
  const rows: { label: string; value: string }[] = [
    { label: t(lang, "reference.detail.kind"), value: referenceKindLabel(item.kind, lang) },
  ];
  if (item.year) rows.push({ label: t(lang, "reference.detail.year"), value: String(item.year) });
  if (item.domains.length > 0)
    rows.push({ label: t(lang, "reference.detail.domains"), value: item.domains.join(" · ") });
  if (item.source) rows.push({ label: t(lang, "reference.detail.source"), value: item.source });
  // 许可与版权只在页尾出现一次，避免同一条信息在页内重复两遍。

  return (
    <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
      {rows.map((row) => (
        <div key={row.label} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-zinc-400 dark:text-zinc-500">{row.label}</dt>
          <dd className="min-w-0 break-words text-zinc-700 dark:text-zinc-300">{row.value}</dd>
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
  const item = await getItem(id);
  if (!item) notFound();
  const admin = await isAdmin();
  if (!admin && !item.isPublic) notFound();
  if (item.isPublic) await recordReferenceView(item.id);
  const lang = await getLang();

  const sourceLabel = hostnameOf(item.url) || (item.source && item.source !== "手动添加" ? item.source : "");
  const renderedHtml = item.bodyMarkdown ? renderMarkdown(item.bodyMarkdown) : "";
  const canDownload = item.license !== "link-only" && item.attachment != null;

  const jsonLd = item.isPublic
    ? {
        "@context": "https://schema.org",
        "@type": item.kind === "test" ? "Report" : "Article",
        headline: item.name,
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
        inLanguage: "zh-CN",
        isPartOf: {
          "@type": "CollectionPage",
          name: "DailyRhapsody Reference",
          url: `${siteUrl}/reference`,
        },
      }
    : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-100 to-white font-sans text-zinc-900 dark:from-black dark:via-zinc-950 dark:to-black dark:text-zinc-50">
      {jsonLd && (
        <script
          type="application/ld+json"
          // 防止正文标题里的 </script> 提前闭合
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      )}
      {/* 顶部固定 bar：返回 + 跳原文 */}
      <div className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 text-sm">
          <Link
            href="/reference"
            className="rounded text-zinc-700 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            ← Reference
          </Link>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              {t(lang, "reference.detail.jump")} ↗
            </a>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <header className="mb-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="rounded-full border border-zinc-200 bg-white/70 px-2 py-0.5 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-300">
              {referenceKindLabel(item.kind, lang)}
            </span>
            {sourceLabel && (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {sourceLabel}
              </span>
            )}
            <span className="opacity-70">·</span>
            <span>收藏于 {formatDate(item.clippedAt)}</span>
          </div>

          <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">
            {item.name || "(无标题)"}
          </h1>

          {item.summary && (
            <p className="mt-3 max-w-2xl text-[0.95rem] leading-relaxed text-zinc-600 dark:text-zinc-300">
              {item.summary}
            </p>
          )}

          <InfoBlock item={item} lang={lang} />
          {item.company ? <CompanyProfileBlock profile={item.company} lang={lang} /> : null}

          {item.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {item.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-zinc-200 px-2 py-0.5 text-[0.7rem] text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {canDownload && (
              <a
                href={`/api/download/reference/${item.id}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-sm text-white transition-apple hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                下载附件
                {item.attachment?.kind === "external" ? " ↗" : ""}
              </a>
            )}
            <ReferenceLikeButton id={item.id} />
            <ReferenceShareButton title={item.name || "Reference"} text={item.summary} />
          </div>
          {canDownload && (
            <p className="mt-2 text-[0.7rem] text-zinc-400 dark:text-zinc-500">
              {t(lang, "reference.detail.pdfNote")}
            </p>
          )}
        </header>

        {renderedHtml ? (
          // 收藏详情是长文阅读页：与博客展开态同一套标题层级，块间距也要显式给
          // （这里没有 EntrySummary 的 space-y 包裹）。
          <article className={`${markdownPreviewProseClass} ${markdownHeadingClass} mt-10 border-t border-zinc-200 pt-8 text-[0.95rem] leading-relaxed dark:border-zinc-800`}>
            <div className="space-y-[1.15em]" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </article>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            正文为空。
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

        <footer className="mt-12 border-t border-zinc-200 pt-5 dark:border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-[0.7rem] font-semibold uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              >
                {(sourceLabel || item.name || "R").slice(0, 1)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-zinc-700 dark:text-zinc-300">
                  {sourceLabel || t(lang, "reference.detail.sourceUnknown")}
                </p>
                <p className="mt-0.5 text-zinc-400 dark:text-zinc-500">
                  {referenceLicenseLabel(item.license, lang)} ·{" "}
                  {item.copyright ? item.copyright : t(lang, "reference.detail.rights")}
                </p>
              </div>
            </div>
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-100"
              >
                {t(lang, "reference.detail.original")} ↗
              </a>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}
