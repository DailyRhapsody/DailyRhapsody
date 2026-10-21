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

/** 正文小标题里的 2.1 / 2.2 是写作编号；版式已有层级，渲染时去掉。 */
function cleanHeadingNumbers(html: string) {
  return html
    .replace(/(<h[1-4][^>]*>)\s*\d+(?:\s*[.、．]\s*\d+)+\s*[.、．]?\s*/g, "$1")
    .replace(/(<h[1-4][^>]*>)\s*\d+\s*[.、．]\s*/g, "$1");
}

function Facts({ facts, lang }: { facts: string[]; lang: Lang }) {
  return (
    <section id="ap-facts" aria-label={t(lang, "company.facts.title")}>
      <p className="ap-eyebrow">{t(lang, "company.facts.title")}</p>
      <dl className="ap-facts mt-3">
        {facts.map((fact) => {
          const index = fact.search(/[：:]/);
          const label = index > 0 ? fact.slice(0, index).trim() : "";
          const value = index > 0 ? fact.slice(index + 1).trim() : fact;
          return (
            <div key={fact} className="ap-fact">
              {label ? <dt>{label}</dt> : null}
              <dd>{value}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * 公司档案的简介：Apple 式资料卡。
 *
 * 左侧目录，右侧一张白色内容面板；解析失败时原样渲染，避免吞内容。
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
  const topRule = showTopRule ? "pt-8" : "";
  const firstSectionTitle = parsed.sections[0]?.title ?? "";
  const skipFirstPositioning =
    skipPositioning && !parsed.intro && /一句话定位|positioning/i.test(firstSectionTitle);
  const sections = skipFirstPositioning ? parsed.sections.slice(1) : parsed.sections;

  if (!source) {
    return (
      <div className={`${topRule} ap-empty`}>
        <div className="ap-empty-icon" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 3.5h8l4 4v13H6z" strokeLinejoin="round" />
            <path d="M14 3.5v4h4M9 12h6M9 15.5h4" strokeLinecap="round" />
          </svg>
        </div>
        <p className="ap-empty-copy">{t(lang, "company.analysis.empty")}</p>
      </div>
    );
  }

  if (!parsed.hasTemplate) {
    return (
      <article className={`${topRule} ap-panel ap-prose`}>
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.intro || source) }} />
      </article>
    );
  }

  const showGrid = hasVerdictGrid(parsed.verdict);
  const hasAside = sections.length > 0;

  return (
    <section aria-label={t(lang, "company.tabs.intro")} className={topRule}>
      {parsed.intro ? <p className="ap-lead">{parsed.intro}</p> : null}

      <div className={hasAside ? "ap-intro-grid" : ""}>
        {hasAside ? (
          <aside className="ap-sidebar">
            <p className="ap-sidebar-label">{t(lang, "company.analysis.toc")}</p>
            <nav aria-label={t(lang, "company.analysis.toc")}>
              {sections.map((section, index) => (
                <a key={section.key} href={`#ap-sec-${index}`}>
                  {cleanTitle(section.title)}
                </a>
              ))}
            </nav>
          </aside>
        ) : null}

        <div className="ap-panel">
          {showGrid ? (
            <div id="ap-verdict" className="ap-verdict">
              {VERDICT_LABELS.map(([key, labelKey]) =>
                parsed.verdict[key] ? (
                  <div key={key}>
                    <p className="ap-verdict-label">{t(lang, labelKey)}</p>
                    <p className="ap-verdict-value">{parsed.verdict[key]}</p>
                  </div>
                ) : null
              )}
            </div>
          ) : parsed.verdictRaw ? (
            <div className="ap-prose">
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.verdictRaw) }} />
            </div>
          ) : null}

          {parsed.facts.length ? <Facts facts={parsed.facts} lang={lang} /> : null}

          {sections.map((section, index) => (
            <section key={section.key} id={`ap-sec-${index}`} className="ap-section">
              <h2>{cleanTitle(section.title)}</h2>
              <div
                className="ap-prose ap-section-body"
                dangerouslySetInnerHTML={{
                  __html: cleanHeadingNumbers(renderMarkdown(section.markdown)),
                }}
              />
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
