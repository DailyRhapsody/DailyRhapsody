"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLang } from "@/components/LangProvider";
import type { SkillCard } from "@/lib/company-skill-card";
import {
  COMPANY_SKILLS,
  companySkillHint,
  companySkillLabel,
  companySkillLine,
  companySkillMaster,
  companySkillMethod,
  type CompanySkillId,
  type CompanySkillMeta,
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

const CARD_PROSE =
  "rd-prose text-[0.84rem] leading-[1.85] [&_p]:my-1 [&_ul]:my-1 [&_ul]:pl-4 " +
  "[&_ol]:my-1 [&_ol]:pl-4 [&_li]:my-0.5 [&_table]:mt-1";

function MasterMark({ master }: { master: string }) {
  return (
    <span aria-hidden className="rd-master-mark">
      {master.slice(0, 1)}
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
  onSelect: (trigger: HTMLButtonElement) => void;
  lang: "zh" | "en";
}) {
  const { t } = useLang();
  const loading = state?.status === "loading";
  const done = state?.status === "done";
  const master = companySkillMaster(skill, lang);
  const method = companySkillMethod(skill, lang);
  const label = companySkillLabel(skill, lang);
  const showLabel = label !== method;
  const line = companySkillLine(skill, lang);

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-busy={loading}
      title={companySkillHint(skill, lang)}
      data-selected={selected ? "true" : undefined}
      onClick={(event) => onSelect(event.currentTarget)}
      disabled={disabled && !loading}
      className="rd-skill-card group focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rd-accent)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="rd-serif text-[0.72rem] text-[var(--rd-accent)]">{skill.number}</span>
        <span className="rd-line-tag">{line}</span>
      </div>

      <div className="mt-5 flex items-start gap-3">
        <MasterMark master={master} />
        <div className="min-w-0">
          <p className="text-[0.68rem] leading-relaxed text-[var(--rd-muted)]">{master}</p>
          <h3 className="rd-serif mt-1 text-[1.24rem] leading-[1.25] text-[var(--rd-ink)]">
            {method}
          </h3>
        </div>
      </div>

      {showLabel ? (
        <p className="mt-2 text-[0.7rem] text-[var(--rd-muted)]">{label}</p>
      ) : null}

      <p className="mt-3 flex-1 text-[0.8rem] leading-[1.75] text-[var(--rd-ink-soft)]">
        {companySkillHint(skill, lang)}
      </p>

      <div className="mt-5 flex items-center justify-between border-t border-[var(--rd-line)] pt-3">
        <span className={`text-[0.66rem] ${done ? "text-[var(--rd-accent)]" : "text-[var(--rd-muted)]"}`}>
          {loading
            ? t("company.skills.running")
            : done
              ? t("company.skills.generated")
              : t("company.skills.analyze")}
        </span>
        {loading ? (
          <span
            aria-hidden
            className="inline-block h-3 w-3 animate-spin rounded-full border border-[var(--rd-accent)] border-t-transparent"
          />
        ) : (
          <span aria-hidden className="text-[0.9rem] text-[var(--rd-accent)]">
            →
          </span>
        )}
      </div>
    </button>
  );
}

function ResultBody({ card, html }: { card: SkillCard | null; html: string }) {
  const { t } = useLang();

  if (!card?.isStructured) {
    return <div className="rd-prose" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <>
      <div
        className={`border p-5 ${
          card.insufficient
            ? "border-[var(--rd-accent)] bg-[var(--rd-accent-soft)] text-[var(--rd-ink)]"
            : "border-[var(--rd-ink)] bg-[var(--rd-hero-bg)] text-[var(--rd-hero-fg)]"
        }`}
      >
        <p className="rd-eyebrow text-[var(--rd-accent)]">
          {t("company.verdict.title")}
        </p>
        <div
          className="rd-serif mt-2 text-[1.18rem] leading-[1.8] [&_p]:m-0"
          dangerouslySetInnerHTML={{ __html: card.judgmentHtml }}
        />
      </div>

      <div className="mt-6 space-y-6">
        <section>
          <p className="rd-eyebrow">{t("company.skills.evidence")}</p>
          <div
            className={`mt-2 ${CARD_PROSE}`}
            dangerouslySetInnerHTML={{ __html: card.evidenceHtml || "—" }}
          />
        </section>
        <section>
          <p className="rd-eyebrow">{t("company.skills.commentary")}</p>
          <div
            className={`mt-2 ${CARD_PROSE}`}
            dangerouslySetInnerHTML={{ __html: card.commentaryHtml || "—" }}
          />
        </section>
      </div>

      <section className="mt-6 border border-[var(--rd-line)] bg-[var(--rd-paper-2)] p-4">
        <div className="h-px w-8 bg-[var(--rd-accent)]" aria-hidden />
        <p className="rd-eyebrow mt-3 text-[var(--rd-accent)]">{t("company.skills.falsifier")}</p>
        <div
          className={`mt-2 ${CARD_PROSE}`}
          dangerouslySetInnerHTML={{ __html: card.falsifierHtml || "—" }}
        />
      </section>

      {card.sourceHtml ? (
        <details className="mt-6 border-t border-[var(--rd-line)] pt-4">
          <summary className="cursor-pointer select-none text-[0.7rem] text-[var(--rd-muted)]">
            {t("company.skills.source")}
          </summary>
          <div
            className={`mt-2 ${CARD_PROSE}`}
            dangerouslySetInnerHTML={{ __html: card.sourceHtml }}
          />
        </details>
      ) : null}
    </>
  );
}

/**
 * 公司档案的第二块：大师之剑。
 *
 * 十五张卡只表明「哪位名人 + 哪套方法论」，点击后才把当前公司档案发给服务端
 * 跑一次模型。结果按公司与技能缓存在服务端；本组件用右侧抽屉呈现判断卡，
 * 关闭后回到卡片墙，已生成的结果不会丢。
 */
export function CompanySkills({ itemId }: { itemId: string }) {
  const { t, lang } = useLang();
  const [active, setActive] = useState<CompanySkillId | null>(null);
  const [results, setResults] = useState<Partial<Record<CompanySkillId, ResultEntry>>>({});
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const busy = Object.values(results).some((entry) => entry?.status === "loading");

  const activeSkill = active ? COMPANY_SKILLS.find((skill) => skill.id === active) ?? null : null;
  const entry = active ? results[active] : undefined;

  const closeDrawer = useCallback(() => {
    restoreFocus.current = true;
    setActive(null);
  }, []);

  useEffect(() => {
    if (active || !restoreFocus.current) return;
    restoreFocus.current = false;
    const timer = window.setTimeout(() => triggerRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeRef.current?.focus(), 40);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(timer);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;

      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, closeDrawer]);

  const run = useCallback(
    async (skillId: CompanySkillId, force = false) => {
      const existing = results[skillId];
      if (!force && existing?.status === "done") {
        setActive(skillId);
        return;
      }
      if (busy) return;

      setActive(skillId);
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
    [busy, itemId, lang, results, t]
  );

  const master = activeSkill ? companySkillMaster(activeSkill, lang) : "";
  const method = activeSkill ? companySkillMethod(activeSkill, lang) : "";
  const label = activeSkill ? companySkillLabel(activeSkill, lang) : "";
  const showLabel = label !== method;
  const time =
    entry?.status === "done"
      ? new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(entry.cachedAt))
      : "";

  return (
    <section aria-label={t("company.master.title")}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {COMPANY_SKILLS.map((skill) => (
          <SkillCardButton
            key={skill.id}
            skill={skill}
            state={results[skill.id]}
            selected={active === skill.id}
            disabled={busy}
            onSelect={(trigger) => {
              triggerRef.current = trigger;
              void run(skill.id);
            }}
            lang={lang}
          />
        ))}
      </div>

      {activeSkill && typeof document !== "undefined"
        ? createPortal(
            <div className="rd-portal font-sans">
              <div className="rd-overlay" onClick={closeDrawer} aria-hidden />
              <aside
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="rd-drawer-title"
            className="rd-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rd-drawer-head px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="rd-eyebrow text-[rgba(245,241,232,0.48)]">
                    {activeSkill.number} · {master}
                  </p>
                  <h2
                    id="rd-drawer-title"
                    className="rd-serif mt-1 text-[1.35rem] leading-tight"
                  >
                    {method}
                  </h2>
                  {showLabel ? (
                    <p className="mt-0.5 text-[0.7rem] text-[rgba(245,241,232,0.55)]">{label}</p>
                  ) : null}
                </div>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={closeDrawer}
                  aria-label={t("company.skills.close")}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/20 text-[1.05rem] leading-none text-[rgba(245,241,232,0.7)] transition-colors hover:border-white/40 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rd-accent)]"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="rd-drawer-body" aria-live="polite">
              {!entry || entry.status === "loading" ? (
                <div className="space-y-4">
                  <p className="rd-eyebrow text-[var(--rd-accent)]">
                    {lang === "en" ? activeSkill.progressEn : activeSkill.progress}
                  </p>
                  <div className="mt-2 space-y-2">
                    <div className="h-6 w-3/4 animate-pulse bg-[var(--rd-line)]" />
                    <div className="h-3 w-full animate-pulse bg-[var(--rd-line)]" />
                    <div className="h-3 w-5/6 animate-pulse bg-[var(--rd-line)]" />
                    <div className="h-3 w-2/3 animate-pulse bg-[var(--rd-line)]" />
                    <div className="h-3 w-11/12 animate-pulse bg-[var(--rd-line)]" />
                    <div className="h-3 w-3/5 animate-pulse bg-[var(--rd-line)]" />
                  </div>
                </div>
              ) : entry.status === "error" ? (
                <div className="border border-[var(--rd-accent)] bg-[var(--rd-accent-soft)] p-4">
                  <p className="rd-eyebrow text-[var(--rd-accent)]">
                    {t("company.skills.error")}
                  </p>
                  <p className="mt-2 text-[0.86rem] leading-relaxed text-[var(--rd-ink)]">
                    {entry.error}
                  </p>
                  <button
                    type="button"
                    onClick={() => void run(activeSkill.id, true)}
                    className="mt-4 border border-[var(--rd-accent)] px-3 py-1.5 text-[0.75rem] text-[var(--rd-ink)] transition-colors hover:bg-[var(--rd-paper)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rd-accent)]"
                  >
                    {t("common.retry")}
                  </button>
                </div>
              ) : (
                <ResultBody card={entry.card} html={entry.html} />
              )}
            </div>

            <div className="rd-drawer-foot flex items-center justify-between gap-3">
              <p className="text-[0.65rem] text-[var(--rd-muted)]">
                {entry?.status === "done"
                  ? `${entry.cached ? `${t("company.skills.cached")} · ` : ""}${time}`
                  : entry?.status === "error"
                    ? ""
                    : t("company.skills.running")}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void run(activeSkill.id, true)}
                  disabled={entry?.status === "loading"}
                  className="border border-[var(--rd-line)] px-3 py-1.5 text-[0.72rem] text-[var(--rd-ink)] transition-colors hover:border-[var(--rd-ink)] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rd-accent)]"
                >
                  {t("company.skills.rerun")}
                </button>
                <button
                  type="button"
                  onClick={closeDrawer}
                  className="border border-[var(--rd-line)] px-3 py-1.5 text-[0.72rem] text-[var(--rd-muted)] transition-colors hover:border-[var(--rd-ink)] hover:text-[var(--rd-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rd-accent)]"
                >
                  {t("company.skills.close")}
                </button>
              </div>
            </div>
              </aside>
            </div>,
            document.body
          )
        : null}
    </section>
  );
}
