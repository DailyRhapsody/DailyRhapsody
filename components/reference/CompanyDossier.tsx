import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import { CompanyAnalysis } from "@/components/reference/CompanyAnalysis";
import { CompanySkills } from "@/components/reference/CompanySkills";
import { CompanyAuthorSword } from "@/components/reference/CompanyAuthorSword";
import { CompanyPhilosophySword } from "@/components/reference/CompanyPhilosophySword";
import { CompanyTabs } from "@/components/reference/CompanyTabs";

/**
 * 公司详情：一份研究档案。
 *
 * 墨色封面 → 四段索引 → 简介 / 哲学之剑 / 大师之剑 / 作者之剑。
 * 这里只做版式与视觉，数据仍由 Notion 档案与既有分析接口提供。
 */
export function CompanyDossier({
  itemId,
  title,
  summary,
  tags,
  bodyMarkdown,
  sourceLabel,
  licenseLabel,
  copyright,
  url,
  lang,
}: {
  itemId: string;
  title: string;
  summary?: string;
  tags: string[];
  bodyMarkdown: string;
  sourceLabel: string;
  licenseLabel: string;
  copyright?: string;
  url?: string;
  lang: Lang;
}) {
  const mark = title.trim().slice(0, 1) || "R";

  return (
    <div className="rd-page min-h-screen font-sans">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-5 sm:px-6 sm:pt-7 lg:px-8">
        <nav className="flex items-center justify-between gap-4 text-[0.7rem] text-[var(--rd-muted)]">
          <Link
            href="/reference"
            className="transition-colors hover:text-[var(--rd-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rd-accent)]"
          >
            ← {t(lang, "reference.detail.back")}
          </Link>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[var(--rd-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rd-accent)]"
            >
              {t(lang, "reference.detail.jump")} ↗
            </a>
          ) : null}
        </nav>

        <header className="rd-hero mt-5">
          <div className="rd-hero-grid" aria-hidden />
          <span className="rd-hero-mark" aria-hidden>
            {mark}
          </span>

          <div className="relative z-10 px-6 py-9 sm:px-10 sm:py-12">
            <p className="rd-eyebrow text-[rgba(245,241,232,0.52)]">Reference / Company dossier</p>
            <h1 className="rd-serif mt-4 max-w-4xl text-[clamp(2.35rem,6vw,4.6rem)] font-semibold leading-[1.06] tracking-tight">
              {title}
            </h1>

            {summary ? (
              <p className="rd-serif mt-5 max-w-3xl text-[1.02rem] leading-[1.9] text-[rgba(245,241,232,0.76)] sm:text-[1.12rem]">
                {summary}
              </p>
            ) : null}

            {tags.length ? (
              <div className="mt-7 flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span key={tag} className="rd-chip">
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="rd-hero-rule mt-8" />
          </div>
        </header>

        <CompanyTabs
          intro={<CompanyAnalysis bodyMarkdown={bodyMarkdown} lang={lang} showTopRule={false} skipPositioning={Boolean(summary)} />}
          philosophy={<CompanyPhilosophySword lang={lang} />}
          master={<CompanySkills itemId={itemId} />}
          author={<CompanyAuthorSword lang={lang} />}
        />

        <footer className="mt-14 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--rd-line)] pt-4 text-[0.68rem] leading-relaxed text-[var(--rd-muted)]">
          {sourceLabel ? <span>{sourceLabel} · </span> : null}
          <span>{licenseLabel}</span>
          {copyright ? <span> · {copyright}</span> : null}
        </footer>
      </div>
    </div>
  );
}
