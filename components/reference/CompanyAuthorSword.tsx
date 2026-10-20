import { t, type Lang } from "@/lib/i18n";

/**
 * 作者之剑的预留位。
 *
 * 这一块要放作者本人的三观与人性判断，当前只预留位置，不生成结论，
 * 也不把作者的价值判断混进大师之剑的技能卡。
 */
export function CompanyAuthorSword({ lang }: { lang: Lang }) {
  return (
    <div className="rd-reserved">
      <span className="rd-reserved-num" aria-hidden>
        Ⅲ
      </span>
      <div className="relative">
        <p className="rd-eyebrow text-[var(--rd-accent)]">Author / 04</p>
        <p className="rd-reserved-copy mt-5">{t(lang, "company.author.placeholder")}</p>
      </div>
      <div className="relative mt-10 flex items-center justify-between border-t border-[var(--rd-line)] pt-3">
        <span className="rd-eyebrow">{t(lang, "company.author.reserved")}</span>
        <span className="rd-serif text-[0.85rem] text-[var(--rd-accent)]" aria-hidden>
          Ⅲ
        </span>
      </div>
    </div>
  );
}
