import { t, type Lang } from "@/lib/i18n";

/**
 * 哲学之剑的预留位。融合主轴还没定义，这里只占位，不生成结论。
 */
export function CompanyPhilosophySword({ lang }: { lang: Lang }) {
  return (
    <div className="ap-empty">
      <div className="ap-empty-icon" aria-hidden>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 5.5h8a4 4 0 0 1 4 4V19H8a4 4 0 0 1-4-4z" strokeLinejoin="round" />
          <path d="M20 5.5h-4a4 4 0 0 0-4 4V19h4a4 4 0 0 0 4-4z" strokeLinejoin="round" />
        </svg>
      </div>
      <p className="ap-eyebrow">Philosophy sword</p>
      <h2 className="ap-empty-title">{t(lang, "company.tabs.philosophy")}</h2>
      <p className="ap-empty-copy">{t(lang, "company.philosophy.placeholder")}</p>
      <p className="ap-empty-note">{t(lang, "company.philosophy.reserved")}</p>
    </div>
  );
}
