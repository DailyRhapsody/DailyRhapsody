"use client";

import { useCallback, useRef, useState } from "react";
import { useLang } from "@/components/LangProvider";
import type { SkillCard } from "@/lib/company-skill-card";

type Entry =
  | { status: "loading" }
  | { status: "done"; card: SkillCard | null; html: string; cachedAt: number; cached: boolean }
  | { status: "error"; error: string };

type AuthorResponse = {
  card?: SkillCard;
  html?: string;
  cachedAt?: number;
  cached?: boolean;
  error?: string;
};

function PersonIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19c.7-3.1 3.2-5 6.5-5s5.8 1.9 6.5 5" strokeLinecap="round" />
    </svg>
  );
}

function AuthorResult({
  entry,
  onRerun,
}: {
  entry: Extract<Entry, { status: "done" }>;
  onRerun: () => void;
}) {
  const { t } = useLang();
  const card = entry.card;

  return (
    <div className="ap-panel mx-auto max-w-[900px]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="ap-eyebrow">Author sword</p>
          <h2 className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.025em] text-[var(--ap-text)]">
            {t("company.author.title")}
          </h2>
          <p className="mt-2 max-w-[42rem] text-[14px] leading-[1.6] text-[var(--ap-secondary)]">
            {t("company.author.disclaimer")}
          </p>
        </div>
        <button
          type="button"
          onClick={onRerun}
          className="ap-btn ap-btn-secondary border border-[var(--ap-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
        >
          {t("company.skills.rerun")}
        </button>
      </div>

      {card?.isStructured ? (
        <>
          <div className="ap-judgment mt-6" data-insufficient={card.insufficient ? "true" : undefined}>
            <p className="ap-judgment-label">{t("company.author.judgment")}</p>
            <div
              className="ap-judgment-text"
              dangerouslySetInnerHTML={{ __html: card.judgmentHtml }}
            />
          </div>

          <section className="ap-result-section mt-6">
            <p className="ap-result-label">{t("company.skills.evidence")}</p>
            <div
              className="ap-result-body"
              dangerouslySetInnerHTML={{ __html: card.evidenceHtml || "—" }}
            />
          </section>

          <section className="ap-result-section">
            <p className="ap-result-label">{t("company.skills.commentary")}</p>
            <div
              className="ap-result-body"
              dangerouslySetInnerHTML={{ __html: card.commentaryHtml || "—" }}
            />
          </section>

          <section className="ap-note">
            <p className="ap-result-label">{t("company.skills.falsifier")}</p>
            <div
              className="ap-result-body"
              dangerouslySetInnerHTML={{ __html: card.falsifierHtml || "—" }}
            />
          </section>

          {card.sourceHtml ? (
            <details className="ap-source">
              <summary>{t("company.skills.source")}</summary>
              <div
                className="ap-result-body mt-2"
                dangerouslySetInnerHTML={{ __html: card.sourceHtml }}
              />
            </details>
          ) : null}
        </>
      ) : (
        <div className="ap-prose mt-6" dangerouslySetInnerHTML={{ __html: entry.html }} />
      )}
    </div>
  );
}

/**
 * 作者之剑：用公开人设中的判断方式分析当前公司。
 *
 * 只调用 /author 接口，不读取私密记忆；生成前只显示说明，点击后才产生费用。
 * 付费闸门尚未接入，当前先免费。
 */
export function CompanyAuthorSword({ itemId }: { itemId: string }) {
  const { t, lang } = useLang();
  const [entry, setEntry] = useState<Entry | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (force = false) => {
      if (busy.current) return;
      if (!force && entry?.status === "done") return;
      busy.current = true;
      setEntry({ status: "loading" });
      try {
        const res = await fetch(`/api/reference/${encodeURIComponent(itemId)}/author`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ lang }),
        });
        const data = (await res.json()) as AuthorResponse;
        if (!res.ok || (!data.card && !data.html)) {
          throw new Error(data.error || t("company.author.error"));
        }
        setEntry({
          status: "done",
          card: data.card ?? null,
          html: data.html ?? "",
          cachedAt: Number(data.cachedAt) || Date.now(),
          cached: Boolean(data.cached),
        });
      } catch (error) {
        setEntry({
          status: "error",
          error: error instanceof Error ? error.message : t("company.author.error"),
        });
      } finally {
        busy.current = false;
      }
    },
    [entry?.status, itemId, lang, t]
  );

  if (!entry) {
    return (
      <div className="ap-empty">
        <div className="ap-empty-icon">
          <PersonIcon />
        </div>
        <p className="ap-eyebrow">Author sword</p>
        <h2 className="ap-empty-title">{t("company.author.title")}</h2>
        <p className="ap-empty-copy">{t("company.author.intro")}</p>
        <button
          type="button"
          onClick={() => void run()}
          className="ap-btn ap-btn-primary mt-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)] focus-visible:ring-offset-2"
        >
          {t("company.author.cta")}
        </button>
        <p className="ap-empty-note">{t("company.author.disclaimer")}</p>
      </div>
    );
  }

  if (entry.status === "loading") {
    return (
      <div className="ap-panel mx-auto max-w-[900px]">
        <p className="ap-eyebrow">Author sword</p>
        <h2 className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.025em] text-[var(--ap-text)]">
          {t("company.author.title")}
        </h2>
        <p className="mt-2 text-[14px] text-[var(--ap-secondary)]">{t("company.author.running")}</p>
        <div className="mt-6 space-y-2">
          <div className="ap-skeleton h-6 w-3/4 animate-pulse" />
          <div className="ap-skeleton h-3 w-full animate-pulse" />
          <div className="ap-skeleton h-3 w-5/6 animate-pulse" />
          <div className="ap-skeleton h-3 w-2/3 animate-pulse" />
          <div className="ap-skeleton h-3 w-11/12 animate-pulse" />
        </div>
      </div>
    );
  }

  if (entry.status === "error") {
    return (
      <div className="ap-panel mx-auto max-w-[900px]">
        <p className="ap-eyebrow">Author sword</p>
        <h2 className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.025em] text-[var(--ap-text)]">
          {t("company.author.title")}
        </h2>
        <div className="ap-note mt-6">
          <p className="ap-result-label text-[var(--ap-orange)]">{t("company.author.error")}</p>
          <p className="ap-result-body">{entry.error}</p>
          <button
            type="button"
            onClick={() => void run(true)}
            className="ap-btn ap-btn-secondary mt-3 border border-[var(--ap-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  return <AuthorResult entry={entry} onRerun={() => void run(true)} />;
}
