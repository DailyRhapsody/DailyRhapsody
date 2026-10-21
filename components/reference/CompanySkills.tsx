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

const CARD_PROSE = "ap-result-body";

function MasterMark({ master }: { master: string }) {
  return (
    <span aria-hidden className="ap-skill-icon">
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
      data-done={done ? "true" : undefined}
      onClick={(event) => onSelect(event.currentTarget)}
      disabled={disabled && !loading}
      className="ap-skill-card focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
    >
      <div className="ap-skill-top">
        <span>Master {skill.number}</span>
        <span>{line}</span>
      </div>

      <div className="ap-skill-master">
        <MasterMark master={master} />
        <div className="min-w-0">
          <p>{master}</p>
          <h3>{method}</h3>
        </div>
      </div>

      {showLabel ? <p className="ap-skill-label">{label}</p> : null}

      <p className="ap-skill-question">{companySkillHint(skill, lang)}</p>

      <div className="ap-skill-foot">
        <span className="ap-skill-action">
          {loading
            ? t("company.skills.running")
            : done
              ? t("company.skills.generated")
              : t("company.skills.analyze")}
        </span>
        {loading ? (
          <span
            aria-hidden
            className="inline-block h-3 w-3 animate-spin rounded-full border border-[var(--ap-blue)] border-t-transparent"
          />
        ) : (
          <span aria-hidden className="ap-chevron">
            ›
          </span>
        )}
      </div>
    </button>
  );
}

function ResultBody({ card, html }: { card: SkillCard | null; html: string }) {
  const { t } = useLang();

  if (!card?.isStructured) {
    return <div className="ap-prose" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <>
      <div className="ap-judgment" data-insufficient={card.insufficient ? "true" : undefined}>
        <p className="ap-judgment-label">{t("company.verdict.title")}</p>
        <div
          className="ap-judgment-text"
          dangerouslySetInnerHTML={{ __html: card.judgmentHtml }}
        />
      </div>

      <div className="mt-2">
        <section className="ap-result-section">
          <p className="ap-result-label">{t("company.skills.evidence")}</p>
          <div
            className={CARD_PROSE}
            dangerouslySetInnerHTML={{ __html: card.evidenceHtml || "—" }}
          />
        </section>
        <section className="ap-result-section">
          <p className="ap-result-label">{t("company.skills.commentary")}</p>
          <div
            className={CARD_PROSE}
            dangerouslySetInnerHTML={{ __html: card.commentaryHtml || "—" }}
          />
        </section>
      </div>

      <section className="ap-note">
        <p className="ap-result-label">{t("company.skills.falsifier")}</p>
        <div
          className={CARD_PROSE}
          dangerouslySetInnerHTML={{ __html: card.falsifierHtml || "—" }}
        />
      </section>

      {card.sourceHtml ? (
        <details className="ap-source">
          <summary>{t("company.skills.source")}</summary>
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
      <div className="ap-skill-grid">
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
            <div className="ap-portal">
              <div className="ap-overlay" onClick={closeDrawer} aria-hidden />
              <aside
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-drawer-title"
            className="ap-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ap-drawer-head">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="ap-drawer-eyebrow">
                    Master {activeSkill.number} · {master}
                  </p>
                  <h2 id="ap-drawer-title" className="ap-drawer-title">
                    {method}
                  </h2>
                  {showLabel ? <p className="ap-drawer-eyebrow mt-1">{label}</p> : null}
                </div>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={closeDrawer}
                  aria-label={t("company.skills.close")}
                  className="ap-close focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="ap-drawer-body" aria-live="polite">
              {!entry || entry.status === "loading" ? (
                <div className="space-y-4">
                  <p className="ap-result-label text-[var(--ap-blue)]">
                    {lang === "en" ? activeSkill.progressEn : activeSkill.progress}
                  </p>
                  <div className="mt-2 space-y-2">
                    <div className="ap-skeleton h-6 w-3/4 animate-pulse" />
                    <div className="ap-skeleton h-3 w-full animate-pulse" />
                    <div className="ap-skeleton h-3 w-5/6 animate-pulse" />
                    <div className="ap-skeleton h-3 w-2/3 animate-pulse" />
                    <div className="ap-skeleton h-3 w-11/12 animate-pulse" />
                    <div className="ap-skeleton h-3 w-3/5 animate-pulse" />
                  </div>
                </div>
              ) : entry.status === "error" ? (
                <div className="ap-note">
                  <p className="ap-result-label text-[var(--ap-orange)]">
                    {t("company.skills.error")}
                  </p>
                  <p className="ap-result-body">{entry.error}</p>
                  <button
                    type="button"
                    onClick={() => void run(activeSkill.id, true)}
                    className="ap-btn ap-btn-secondary mt-3 border border-[var(--ap-border)]"
                  >
                    {t("common.retry")}
                  </button>
                </div>
              ) : (
                <ResultBody card={entry.card} html={entry.html} />
              )}
            </div>

            <div className="ap-drawer-foot">
              <p className="ap-drawer-time">
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
                  className="ap-btn ap-btn-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)] focus-visible:ring-offset-2"
                >
                  {t("company.skills.rerun")}
                </button>
                <button
                  type="button"
                  onClick={closeDrawer}
                  className="ap-btn ap-btn-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
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
