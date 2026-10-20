"use client";

import { useCallback, useRef, useState } from "react";
import { useLang } from "@/components/LangProvider";
import type { SkillCard } from "@/lib/company-skill-card";
import {
  COMPANY_SKILLS,
  companySkillEvidence,
  companySkillGrammar,
  companySkillHint,
  companySkillLabel,
  companySkillLine,
  type CompanySkillId,
  type CompanySkillMeta,
  type EvidenceState,
} from "@/lib/company-skills";

type ResultEntry =
  | { status: "loading" }
  | { status: "done"; card: SkillCard | null; html: string; cachedAt: number; cached: boolean }
  | { status: "error"; error: string };

type AnalyzeResponse = {
  card?: SkillCard;
  html?: string;
  cachedAt?: number;
  cached?: boolean;
  error?: string;
};

const PROSE =
  "space-y-2 text-[0.88rem] leading-relaxed text-zinc-700 dark:text-zinc-300 " +
  "[&_h2]:mt-4 [&_h2]:text-[0.98rem] [&_h2]:font-semibold [&_h2]:text-zinc-900 dark:[&_h2]:text-zinc-50 " +
  "[&_h3]:mt-3 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 " +
  "[&_li]:my-1 [&_p]:my-2 [&_strong]:font-semibold [&_table]:w-full [&_table]:text-left " +
  "[&_th]:border [&_th]:border-zinc-200 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-zinc-200 [&_td]:px-2 [&_td]:py-1 " +
  "dark:[&_th]:border-zinc-700 dark:[&_td]:border-zinc-700";

const CARD_PROSE =
  "text-[0.82rem] leading-relaxed text-zinc-600 dark:text-zinc-300 " +
  "[&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 " +
  "[&_li]:my-0.5 [&_strong]:font-semibold [&_table]:mt-1 [&_table]:w-full [&_table]:text-left " +
  "[&_th]:border [&_th]:border-zinc-200 [&_th]:px-1.5 [&_th]:py-1 [&_td]:border [&_td]:border-zinc-200 [&_td]:px-1.5 [&_td]:py-1 " +
  "dark:[&_th]:border-zinc-700 dark:[&_td]:border-zinc-700";

const DOT: Record<EvidenceState, string> = {
  runnable: "bg-emerald-500",
  partial: "bg-amber-400",
  blocked: "bg-zinc-300 dark:bg-zinc-600",
};

function EvidenceDots({ skill, lang }: { skill: CompanySkillMeta; lang: "zh" | "en" }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {(["a", "b", "c"] as const).map((level) => (
        <span
          key={level}
          title={companySkillEvidence(skill, level, lang)}
          className="inline-flex items-center gap-1 text-[0.62rem] uppercase tracking-wide text-zinc-400 dark:text-zinc-500"
        >
          {level}
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[skill.evidence[level]]}`} />
        </span>
      ))}
    </span>
  );
}

function SkillCardButton({
  skill,
  state,
  selected,
  disabled,
  onSelect,
  lang,
}: {
  skill: CompanySkillMeta;
  state: ResultEntry | undefined;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  lang: "zh" | "en";
}) {
  const { t } = useLang();
  const loading = state?.status === "loading";
  const done = state?.status === "done";
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-busy={loading}
      title={companySkillHint(skill, lang)}
      onClick={onSelect}
      disabled={disabled && !loading}
      className={`group block w-full rounded-2xl border p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? "border-zinc-900 bg-white shadow-md dark:border-zinc-100 dark:bg-zinc-900"
          : "border-zinc-200/90 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-600"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[0.65rem] tabular-nums tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
          {skill.number}
          <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[0.6rem] tracking-normal text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {companySkillGrammar(skill, lang)}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-[0.65rem] text-zinc-400 dark:text-zinc-500">
          {loading ? (
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
            />
          ) : done ? (
            <span aria-hidden className="text-emerald-600 dark:text-emerald-400">
              ✓
            </span>
          ) : null}
          {companySkillLine(skill, lang)}
        </span>
      </div>

      <h3 className="mt-3 text-[0.95rem] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        {companySkillLabel(skill, lang)}
      </h3>
      <p className="mt-1.5 line-clamp-3 text-[0.78rem] leading-relaxed text-zinc-500 dark:text-zinc-400">
        {companySkillHint(skill, lang)}
      </p>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <EvidenceDots skill={skill} lang={lang} />
        <span className="text-[0.65rem] text-zinc-400 transition-colors group-hover:text-zinc-700 dark:text-zinc-500 dark:group-hover:text-zinc-200">
          {done ? t("company.skills.generated") : t("company.skills.analyze")}
        </span>
      </div>
    </button>
  );
}

function SkillResultCard({
  skill,
  entry,
  lang,
  onRerun,
  onClose,
}: {
  skill: CompanySkillMeta;
  entry: Extract<ResultEntry, { status: "done" }>;
  lang: "zh" | "en";
  onRerun: () => void;
  onClose: () => void;
}) {
  const { t } = useLang();
  const card = entry.card;
  const time = new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(entry.cachedAt));

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-[0.65rem] tabular-nums tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
            {skill.number}
            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[0.6rem] tracking-normal text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {companySkillGrammar(skill, lang)}
            </span>
            <span className="tracking-normal">{companySkillLine(skill, lang)}</span>
          </p>
          <h3 className="mt-1 text-[1.05rem] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {companySkillLabel(skill, lang)}
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[0.68rem] text-zinc-400 dark:text-zinc-500">
          <EvidenceDots skill={skill} lang={lang} />
          {entry.cached ? (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
              {t("company.skills.cached")}
            </span>
          ) : null}
          <span>{time}</span>
          <button
            type="button"
            onClick={onRerun}
            className="rounded-full px-2 py-1 text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            {t("company.skills.rerun")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            {t("company.skills.close")}
          </button>
        </div>
      </div>

      {card?.isStructured ? (
        <>
          <div
            className={`mt-4 rounded-xl border px-4 py-3 text-[1.02rem] font-medium leading-relaxed ${
              card.insufficient
                ? "border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200"
                : "border-zinc-200 bg-zinc-50/70 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-50"
            }`}
          >
            <div
              className="[&_p]:m-0"
              dangerouslySetInnerHTML={{ __html: card.judgmentHtml }}
            />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <section>
              <h4 className="text-[0.66rem] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
                {t("company.skills.evidence")}
              </h4>
              <div
                className={`mt-1.5 ${CARD_PROSE}`}
                dangerouslySetInnerHTML={{ __html: card.evidenceHtml || "—" }}
              />
            </section>
            <section>
              <h4 className="text-[0.66rem] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
                {t("company.skills.commentary")}
              </h4>
              <div
                className={`mt-1.5 ${CARD_PROSE}`}
                dangerouslySetInnerHTML={{ __html: card.commentaryHtml || "—" }}
              />
            </section>
          </div>

          <section className="mt-4 rounded-xl border-l-2 border-amber-300 bg-amber-50/40 px-3 py-2 dark:border-amber-700 dark:bg-amber-950/10">
            <h4 className="text-[0.66rem] font-medium tracking-wide text-amber-700/80 dark:text-amber-400/80">
              {t("company.skills.falsifier")}
            </h4>
            <div
              className={`mt-1 ${CARD_PROSE}`}
              dangerouslySetInnerHTML={{ __html: card.falsifierHtml || "—" }}
            />
          </section>

          {card.sourceHtml ? (
            <details className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <summary className="cursor-pointer text-[0.7rem] text-zinc-400 select-none dark:text-zinc-500">
                {t("company.skills.source")}
              </summary>
              <div className={`mt-2 ${CARD_PROSE}`} dangerouslySetInnerHTML={{ __html: card.sourceHtml }} />
            </details>
          ) : null}
        </>
      ) : (
        <div className={`mt-4 ${PROSE}`} dangerouslySetInnerHTML={{ __html: entry.html }} />
      )}
    </div>
  );
}

/**
 * 公司档案的第二块：大师之剑。
 *
 * 十五张技能卡只是入口；点击后才把当前公司档案发给服务端跑一次模型，
 * 返回一张判断卡。结果按公司与技能缓存在服务端，也留在本组件状态里，
 * 切换卡片不丢已生成的结果。
 */
export function CompanySkills({ itemId }: { itemId: string }) {
  const { t, lang } = useLang();
  const [active, setActive] = useState<CompanySkillId | null>(null);
  const [results, setResults] = useState<Partial<Record<CompanySkillId, ResultEntry>>>({});
  const panelRef = useRef<HTMLDivElement | null>(null);
  const busy = Object.values(results).some((entry) => entry?.status === "loading");
  const doneCount = Object.values(results).filter((entry) => entry?.status === "done").length;

  const reveal = useCallback(() => {
    requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, []);

  const run = useCallback(
    async (skillId: CompanySkillId, force = false) => {
      const existing = results[skillId];
      if (!force && existing?.status === "done") {
        setActive(skillId);
        reveal();
        return;
      }
      if (busy) return;
      setActive(skillId);
      reveal();
      setResults((prev) => ({ ...prev, [skillId]: { status: "loading" } }));
      try {
        const res = await fetch(`/api/reference/${encodeURIComponent(itemId)}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ skill: skillId, lang }),
        });
        const data = (await res.json()) as AnalyzeResponse;
        if (!res.ok || (!data.card && !data.html)) {
          throw new Error(data.error || t("company.skills.error"));
        }
        setResults((prev) => ({
          ...prev,
          [skillId]: {
            status: "done",
            card: data.card ?? null,
            html: data.html ?? "",
            cachedAt: Number(data.cachedAt) || Date.now(),
            cached: Boolean(data.cached),
          },
        }));
      } catch (error) {
        setResults((prev) => ({
          ...prev,
          [skillId]: {
            status: "error",
            error: error instanceof Error ? error.message : t("company.skills.error"),
          },
        }));
      }
    },
    [busy, itemId, lang, results, reveal, t]
  );

  const activeSkill = active ? COMPANY_SKILLS.find((skill) => skill.id === active) ?? null : null;
  const entry = active ? results[active] : undefined;

  return (
    <section aria-label={t("company.master.title")} className="mt-10 border-t border-zinc-200 pt-7 dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[1rem] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {t("company.master.title")}
        </h2>
        <p className="text-[0.7rem] text-zinc-400 dark:text-zinc-500">
          {t("company.master.note")}
          {doneCount ? ` · ${doneCount}/15` : ""}
        </p>
      </div>
      <p className="mt-2 text-[0.66rem] leading-relaxed text-zinc-400 dark:text-zinc-500">
        {t("company.master.legend")}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {COMPANY_SKILLS.map((skill) => (
          <SkillCardButton
            key={skill.id}
            skill={skill}
            state={results[skill.id]}
            selected={active === skill.id}
            disabled={busy}
            onSelect={() => void run(skill.id)}
            lang={lang}
          />
        ))}
      </div>

      <div ref={panelRef} aria-live="polite" className="mt-2 scroll-mt-24">
        {!active ? (
          <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-5 text-center text-[0.78rem] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
            {t("company.skills.empty")}
          </p>
        ) : null}

        {active && entry?.status === "loading" && activeSkill ? (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-5 dark:border-zinc-800 dark:bg-zinc-900/30">
            <p className="text-[0.7rem] text-zinc-400 dark:text-zinc-500">
              {companySkillLabel(activeSkill, lang)}
              <span className="px-1.5 opacity-40">·</span>
              {lang === "en" ? activeSkill.progressEn : activeSkill.progress}
            </p>
            <div className="mt-4 space-y-2">
              <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800" />
              <div className="h-3 w-full animate-pulse rounded bg-zinc-200/50 dark:bg-zinc-800/70" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-zinc-200/50 dark:bg-zinc-800/70" />
            </div>
          </div>
        ) : null}

        {active && entry?.status === "error" ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5 text-[0.82rem] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300">
            <p>{entry.error}</p>
            <button
              type="button"
              onClick={() => void run(active, true)}
              className="mt-3 rounded-full border border-rose-300 px-3 py-1 text-[0.75rem] hover:bg-rose-100/60 dark:border-rose-800 dark:hover:bg-rose-900/30"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : null}

        {active && entry?.status === "done" && activeSkill ? (
          <SkillResultCard
            skill={activeSkill}
            entry={entry}
            lang={lang}
            onRerun={() => void run(active, true)}
            onClose={() => setActive(null)}
          />
        ) : null}
      </div>
    </section>
  );
}
