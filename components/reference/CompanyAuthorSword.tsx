import { t, type Lang } from "@/lib/i18n";

/**
 * 公司档案的第三块：作者之剑。
 *
 * 这一块要放作者本人的三观与人性判断，当前只预留位置，不生成结论，
 * 也不把作者的价值判断混进大师之剑的技能卡。
 */
export function CompanyAuthorSword({ lang }: { lang: Lang }) {
  return (
    <section
      aria-label={t(lang, "company.author.title")}
      className="mt-10 border-t border-zinc-200 pt-7 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[1rem] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {t(lang, "company.author.title")}
        </h2>
        <p className="text-[0.7rem] text-zinc-400 dark:text-zinc-500">
          {t(lang, "company.author.note")}
        </p>
      </div>
      <div className="mt-4 rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/40 px-5 py-6 dark:border-zinc-800 dark:bg-zinc-900/20">
        <p className="text-[0.84rem] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t(lang, "company.author.placeholder")}
        </p>
        <p className="mt-2 text-[0.68rem] tracking-wide text-zinc-400 dark:text-zinc-500">
          {t(lang, "company.author.reserved")}
        </p>
      </div>
    </section>
  );
}
