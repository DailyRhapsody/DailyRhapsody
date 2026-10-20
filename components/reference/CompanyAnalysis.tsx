import { parseCompanyAnalysis, hasVerdictGrid } from "@/lib/company-analysis";
import { t, type Lang } from "@/lib/i18n";
import { renderMarkdown } from "@/lib/markdown";

const VERDICT_LABELS = [
  ["bet", "company.verdict.bet"],
  ["defense", "company.verdict.defense"],
  ["death", "company.verdict.death"],
  ["falsifier", "company.verdict.falsifier"],
] as const;

function cleanTitle(title: string) {
  return title.replace(/^\s*(?:\d+(?:[.、．]\d+)*)[.、．]?\s*/, "");
}

/** 正文小标题里的 2.1 / 2.2 是写作编号；版式已有章节号，渲染时去掉。 */
function cleanHeadingNumbers(html: string) {
  return html
    .replace(/(<h[1-4][^>]*>)\s*\d+(?:\s*[.、．]\s*\d+)+\s*[.、．]?\s*/g, "$1")
    .replace(/(<h[1-4][^>]*>)\s*\d+\s*[.、．]\s*/g, "$1");
}

function Facts({ facts, lang }: { facts: string[]; lang: Lang }) {
  return (
    <section id="rd-facts" className="rd-section border-y border-[var(--rd-line)] py-5">
      <p className="rd-eyebrow">{t(lang, "company.facts.title")}</p>
      <dl className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {facts.map((fact) => {
          const index = fact.search(/[：:]/);
          const label = index > 0 ? fact.slice(0, index).trim() : "";
          const value = index > 0 ? fact.slice(index + 1).trim() : fact;
          return (
            <div key={fact} className="flex min-w-0 gap-3">
              {label ? (
                <dt className="w-20 shrink-0 pt-0.5 text-[0.68rem] text-[var(--rd-muted)]">
                  {label}
                </dt>
              ) : null}
              <dd className={`min-w-0 break-words text-[0.82rem] leading-relaxed text-[var(--rd-ink-soft)] ${label ? "" : "sm:col-span-2"}`}>
                {value}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * 公司档案的简介：一份可读的研究档案。
 *
 * 版式是“目录 + 正文”的杂志结构：左侧章节索引，右侧判断、档案事实与分节正文。
 * 解析失败时原样渲染，避免吞掉作者写的内容。
 */
export function CompanyAnalysis({
  bodyMarkdown,
  lang,
  showTopRule = true,
  skipPositioning = false,
}: {
  bodyMarkdown: string;
  lang: Lang;
  showTopRule?: boolean;
  skipPositioning?: boolean;
}) {
  const source = bodyMarkdown?.trim() ?? "";
  const parsed = parseCompanyAnalysis(source);
  const topRule = showTopRule ? "border-t border-[var(--rd-line)] pt-8" : "";
  const firstSectionTitle = parsed.sections[0]?.title ?? "";
  const skipFirstPositioning =
    skipPositioning && !parsed.intro && /一句话定位|positioning/i.test(firstSectionTitle);
  const sections = skipFirstPositioning ? parsed.sections.slice(1) : parsed.sections;

  if (!source) {
    return (
      <div className={`${topRule} rd-reserved min-h-[220px]`}>
        <p className="rd-eyebrow">Archive / Empty</p>
        <p className="rd-reserved-copy">{t(lang, "company.analysis.empty")}</p>
      </div>
    );
  }

  if (!parsed.hasTemplate) {
    return (
      <article className={`${topRule} rd-prose`}>
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.intro || source) }} />
      </article>
    );
  }

  const showGrid = hasVerdictGrid(parsed.verdict);
  const hasAside = sections.length > 0;

  return (
    <section aria-label={t(lang, "company.tabs.intro")} className={topRule}>
      {parsed.intro ? (
        <p className="rd-serif rd-lead max-w-3xl">{parsed.intro}</p>
      ) : null}

      <div className={`grid gap-10 ${hasAside ? "lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-14" : ""} ${parsed.intro ? "mt-10" : ""}`}>
        {hasAside ? (
          <aside className="hidden lg:sticky lg:top-20 lg:block lg:self-start">
            <p className="rd-eyebrow">{t(lang, "company.analysis.toc")}</p>
            <nav className="rd-toc mt-4" aria-label={t(lang, "company.analysis.toc")}>
              {sections.map((section, index) => (
                <a key={section.key} href={`#rd-sec-${index}`}>
                  <span className="w-6 shrink-0 font-serif text-[0.68rem] text-[var(--rd-accent)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{cleanTitle(section.title)}</span>
                </a>
              ))}
            </nav>
          </aside>
        ) : null}

        <div className="min-w-0 max-w-[46rem] space-y-12">
          {showGrid ? (
            <div id="rd-verdict" className="rd-section rd-verdict rd-rise">
              {VERDICT_LABELS.map(([key, labelKey]) =>
                parsed.verdict[key] ? (
                  <div key={key}>
                    <dt className="rd-verdict-label">{t(lang, labelKey)}</dt>
                    <dd className="rd-serif mt-2 text-[1.02rem] leading-[1.75]">
                      {parsed.verdict[key]}
                    </dd>
                  </div>
                ) : null
              )}
            </div>
          ) : parsed.verdictRaw ? (
            <div id="rd-verdict" className="rd-section rd-prose">
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.verdictRaw) }} />
            </div>
          ) : null}

          {parsed.facts.length ? <Facts facts={parsed.facts} lang={lang} /> : null}

          {sections.map((section, index) => {
            const sourceSection = /来源|source/i.test(section.title);
            return (
              <section key={section.key} id={`rd-sec-${index}`} className="rd-section">
                <div className="rd-section-head">
                  <span className="rd-section-num">{String(index + 1).padStart(2, "0")}</span>
                  <h2 className="rd-section-title">{cleanTitle(section.title)}</h2>
                </div>
                <div
                  className={`rd-prose mt-4 ${index === 0 && !parsed.intro && !skipFirstPositioning ? "rd-lead" : ""} ${sourceSection ? "text-[0.8rem]" : ""}`}
                  dangerouslySetInnerHTML={{ __html: cleanHeadingNumbers(renderMarkdown(section.markdown)) }}
                />
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}
