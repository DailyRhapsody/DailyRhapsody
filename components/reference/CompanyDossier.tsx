import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import { CompanyAnalysis } from "@/components/reference/CompanyAnalysis";
import { CompanySkills } from "@/components/reference/CompanySkills";
import { CompanyAuthorSword } from "@/components/reference/CompanyAuthorSword";
import { CompanyPhilosophySword } from "@/components/reference/CompanyPhilosophySword";
import { CompanyTabs } from "@/components/reference/CompanyTabs";

/**
 * 公司详情：Apple 式资料页。
 *
 * 大标题 + 摘要 + 标签，下面是一段吸顶的分段控件与四块内容。
 * 数据仍由 Notion 档案与既有分析接口提供。
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
  return (
    <div className="ap-page min-h-screen">
      <nav className="ap-nav">
        <Link
          href="/reference"
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
        >
          ‹ {t(lang, "reference.detail.back")}
        </Link>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
          >
            {t(lang, "reference.detail.jump")} ↗
          </a>
        ) : null}
      </nav>

      <header className="ap-hero">
        <p className="ap-eyebrow">Reference · Company dossier</p>
        <h1 className="ap-hero-title">{title}</h1>
        {summary ? <p className="ap-hero-summary">{summary}</p> : null}
        {tags.length ? (
          <div className="ap-tags">
            {tags.map((tag) => (
              <span key={tag} className="ap-tag">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      <CompanyTabs
        intro={
          <CompanyAnalysis
            bodyMarkdown={bodyMarkdown}
            lang={lang}
            showTopRule={false}
            skipPositioning={Boolean(summary)}
          />
        }
        philosophy={<CompanyPhilosophySword lang={lang} />}
        master={<CompanySkills itemId={itemId} />}
        author={<CompanyAuthorSword lang={lang} />}
      />

      <footer className="ap-footer">
        {sourceLabel ? <span>{sourceLabel} · </span> : null}
        <span>{licenseLabel}</span>
        {copyright ? <span> · {copyright}</span> : null}
      </footer>
    </div>
  );
}
