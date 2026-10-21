import { t, type Lang } from "@/lib/i18n";

/**
 * 作者之剑的预留位。
 *
 * 这一块要放作者本人的三观与人性判断，当前只预留位置，不生成结论，
 * 也不把作者的价值判断混进大师之剑的技能卡。
 */
export function CompanyAuthorSword({ lang }: { lang: Lang }) {
  return (
    <div className="ap-empty">
      <div className="ap-empty-icon" aria-hidden>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="8" r="3.2" />
          <path d="M5.5 19c.7-3.1 3.2-5 6.5-5s5.8 1.9 6.5 5" strokeLinecap="round" />
        </svg>
      </div>
      <p className="ap-eyebrow">Author sword</p>
      <h2 className="ap-empty-title">{t(lang, "company.tabs.author")}</h2>
      <p className="ap-empty-copy">{t(lang, "company.author.placeholder")}</p>
      <p className="ap-empty-note">{t(lang, "company.author.reserved")}</p>
    </div>
  );
}
