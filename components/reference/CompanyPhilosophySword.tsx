import { t, type Lang } from "@/lib/i18n";

/**
 * 哲学之剑的预留位。融合主轴还没定义，这里只占位，不生成结论。
 */
export function CompanyPhilosophySword({ lang }: { lang: Lang }) {
  return (
    <div className="rd-reserved">
      <span className="rd-reserved-num" aria-hidden>
        Ⅰ
      </span>
      <div className="relative">
        <p className="rd-eyebrow text-[var(--rd-accent)]">Philosophy / 02</p>
        <p className="rd-reserved-copy mt-5">{t(lang, "company.philosophy.placeholder")}</p>
      </div>
      <div className="relative mt-10 flex items-center justify-between border-t border-[var(--rd-line)] pt-3">
        <span className="rd-eyebrow">{t(lang, "company.philosophy.reserved")}</span>
        <span className="rd-serif text-[0.85rem] text-[var(--rd-accent)]" aria-hidden>
          Ⅰ
        </span>
      </div>
    </div>
  );
}
