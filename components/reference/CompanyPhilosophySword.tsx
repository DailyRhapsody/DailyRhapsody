import { t, type Lang } from "@/lib/i18n";

/**
 * 哲学之剑的预留位。融合主轴还没定义，这里只占位，不生成结论。
 */
export function CompanyPhilosophySword({ lang }: { lang: Lang }) {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/40 px-5 py-6 dark:border-zinc-800 dark:bg-zinc-900/20">
      <p className="text-[0.84rem] leading-relaxed text-zinc-500 dark:text-zinc-400">
        {t(lang, "company.philosophy.placeholder")}
      </p>
      <p className="mt-2 text-[0.68rem] tracking-wide text-zinc-400 dark:text-zinc-500">
        {t(lang, "company.philosophy.reserved")}
      </p>
    </div>
  );
}
