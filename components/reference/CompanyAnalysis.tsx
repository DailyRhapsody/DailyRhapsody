import { parseCompanyAnalysis, hasVerdictGrid } from "@/lib/company-analysis";
import { t, type Lang } from "@/lib/i18n";
import {
  renderMarkdown,
  markdownHeadingClass,
  markdownPreviewProseClass,
} from "@/lib/markdown";

const VERDICT_LABELS = [
  ["bet", "company.verdict.bet"],
  ["defense", "company.verdict.defense"],
  ["death", "company.verdict.death"],
  ["falsifier", "company.verdict.falsifier"],
] as const;

function Facts({ facts, lang }: { facts: string[]; lang: Lang }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
      <h2 className="text-[0.72rem] font-medium tracking-wide text-zinc-500 dark:text-zinc-400">
        {t(lang, "company.facts.title")}
      </h2>
      <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-[0.82rem] leading-relaxed sm:grid-cols-2">
        {facts.map((fact) => {
          const index = fact.search(/[：:]/);
          const label = index > 0 ? fact.slice(0, index).trim() : "";
          const value = index > 0 ? fact.slice(index + 1).trim() : fact;
          return (
            <div key={fact} className="flex min-w-0 gap-2">
              {label ? (
                <dt className="shrink-0 text-zinc-400 dark:text-zinc-500">{label}</dt>
              ) : null}
              <dd className="min-w-0 break-words text-zinc-700 dark:text-zinc-300">{value}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * 公司档案正文的第一块：结构化综合分析。
 *
 * 方法论名称不出现在页面上，读者只看到判断、事实与分节结论。模板之外的正文
 * 原样渲染，解析失败不会吞内容。
 */
export function CompanyAnalysis({
  bodyMarkdown,
  lang,
  showTopRule = true,
}: {
  bodyMarkdown: string;
  lang: Lang;
  showTopRule?: boolean;
}) {
  const source = bodyMarkdown?.trim() ?? "";
  const parsed = parseCompanyAnalysis(source);
  const topRule = showTopRule
    ? "mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800"
    : "mt-4";

  if (!source) {
    return (
      <p className={`${topRule} text-sm text-zinc-500 dark:text-zinc-400`}>
        {t(lang, "company.analysis.empty")}
      </p>
    );
  }

  if (!parsed.hasTemplate) {
    return (
      <article
        className={`${markdownPreviewProseClass} ${markdownHeadingClass} ${topRule} text-[0.95rem] leading-relaxed`}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.intro || source) }}
      />
    );
  }

  const showGrid = hasVerdictGrid(parsed.verdict);

  return (
    <section aria-label={t(lang, "company.analysis.title")} className={`${showTopRule ? "mt-8" : "mt-4"} space-y-7`}>
      {parsed.intro ? (
        <p className="text-[0.92rem] leading-relaxed text-zinc-600 dark:text-zinc-300">
          {parsed.intro}
        </p>
      ) : null}

      {showGrid ? (
        <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-800">
          {VERDICT_LABELS.map(([key, labelKey]) =>
            parsed.verdict[key] ? (
              <div key={key} className="bg-white p-4 dark:bg-zinc-950">
                <dt className="text-[0.68rem] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
                  {t(lang, labelKey)}
                </dt>
                <dd className="mt-1.5 text-[0.88rem] leading-relaxed text-zinc-800 dark:text-zinc-200">
                  {parsed.verdict[key]}
                </dd>
              </div>
            ) : null
          )}
        </div>
      ) : parsed.verdictRaw ? (
        <div
          className={`${markdownPreviewProseClass} ${markdownHeadingClass} text-[0.92rem] leading-relaxed`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.verdictRaw) }}
        />
      ) : null}

      {parsed.facts.length ? <Facts facts={parsed.facts} lang={lang} /> : null}

      {parsed.sections.map((section, index) => (
        <section key={section.key}>
          <h2 className="flex items-baseline gap-2 text-[1rem] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            <span className="text-[0.7rem] font-normal tabular-nums text-zinc-300 dark:text-zinc-600">
              {String(index + 1).padStart(2, "0")}
            </span>
            {section.title}
          </h2>
          <div
            className={`${markdownPreviewProseClass} ${markdownHeadingClass} mt-2 text-[0.92rem] leading-relaxed`}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(section.markdown) }}
          />
        </section>
      ))}
    </section>
  );
}
