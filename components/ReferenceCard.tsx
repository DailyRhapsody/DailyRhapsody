"use client";

import Link from "next/link";
import type { ReferenceListItem } from "@/hooks/useReference";
import type { ReferenceLikeState } from "@/hooks/useReferenceLikes";
import { useLang } from "@/components/LangProvider";
import { referenceKindLabel } from "@/lib/reference-taxonomy";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 20.25s-7.5-4.6-7.5-10.1A4.15 4.15 0 0 1 12 7.3a4.15 4.15 0 0 1 7.5 2.85c0 5.5-7.5 10.1-7.5 10.1Z"
      />
    </svg>
  );
}

function KindIcon({ kind }: { kind: ReferenceListItem["kind"] }) {
  const cls = "h-5 w-5";
  if (kind === "company") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V7l8-3 8 3v13M9 20v-5h6v5M8 9h.01M12 9h.01M16 9h.01M8 12.5h.01M12 12.5h.01M16 12.5h.01" />
      </svg>
    );
  }
  if (kind === "test") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 19h16M7 16V9m5 7V5m5 11v-4" />
      </svg>
    );
  }
  if (kind === "commentary") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 6h14v9H9l-4 3V6Z" />
      </svg>
    );
  }
  if (kind === "interview") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Zm-6 8a6 6 0 0 0 12 0M12 18v3m-3 0h6" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l4 4v14H7V3Zm7 0v5h4M9.5 12h6M9.5 15.5h6" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

/** 选中标记：实心点时表示「已选中」，空心圈表示可选中。 */
function TargetIcon({ filled }: { filled: boolean }) {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <circle cx="12" cy="12" r="7" />
      {filled ? <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

export function ReferenceCard({
  item,
  like,
  onLike,
  onSelect,
  selected = false,
}: {
  item: ReferenceListItem;
  like?: ReferenceLikeState;
  onLike?: (id: string) => void;
  onSelect?: (id: string) => void;
  selected?: boolean;
}) {
  const { t, lang } = useLang();
  const displayName = item.titleZh?.trim() || item.name || t("reference.card.untitled");
  const sourceLabel = hostnameOf(item.url) || (item.source && item.source !== "手动添加" ? item.source : "");
  const profile = item.company;

  return (
    <article
      aria-current={selected ? "true" : undefined}
      data-selected={selected || undefined}
      className={`group flex h-full flex-col rounded-xl border p-4 transition-apple ${
        selected
          ? "border-zinc-900 bg-white shadow-md ring-2 ring-zinc-900/15 ring-offset-2 ring-offset-zinc-50 dark:border-zinc-100 dark:bg-zinc-900 dark:ring-zinc-100/20 dark:ring-offset-zinc-950"
          : "border-zinc-200 bg-white/75 hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          <KindIcon kind={item.kind} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3 text-[0.68rem] text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-zinc-600 dark:text-zinc-300">
              {referenceKindLabel(item.kind, lang)}
            </span>
            <span className="min-w-0 truncate text-right">
              {sourceLabel}
              {sourceLabel && item.year ? <span className="px-1 opacity-50">·</span> : null}
              {item.year || null}
            </span>
          </div>
          <h3 className="mt-1.5 text-[0.98rem] font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
            <Link
              href={`/reference/${item.id}`}
              className="line-clamp-2 rounded transition-colors hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:hover:text-blue-300"
            >
              {displayName}
            </Link>
          </h3>
        </div>
      </div>

      {item.summary ? (
        <p className="mt-3 line-clamp-3 text-[0.8rem] leading-relaxed text-zinc-600 dark:text-zinc-400">
          {item.summary}
        </p>
      ) : null}

      {profile ? (
        <dl className="mt-2 grid grid-cols-1 gap-1 text-[0.68rem] leading-4 text-zinc-500 dark:text-zinc-400">
          {profile.scenarios.length > 0 ? (
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 whitespace-nowrap text-zinc-400 dark:text-zinc-500">{t("reference.card.scenarios")}</dt>
              <dd className="truncate">{profile.scenarios.join(" · ")}</dd>
            </div>
          ) : null}
          {profile.productForms.length > 0 ? (
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 whitespace-nowrap text-zinc-400 dark:text-zinc-500">{t("reference.card.products")}</dt>
              <dd className="truncate">{profile.productForms.join(" · ")}</dd>
            </div>
          ) : null}
          {profile.operationCulture ? (
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 whitespace-nowrap text-zinc-400 dark:text-zinc-500">{t("reference.card.culture")}</dt>
              <dd className="truncate">{profile.operationCulture}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className="mt-auto flex items-end justify-between gap-2 pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {item.domains.slice(0, 2).map((domain) => (
            <span
              key={domain}
              className="rounded-full border border-zinc-200 px-2 py-0.5 text-[0.65rem] text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
            >
              {domain}
            </span>
          ))}
          {(item.robotTypes ?? []).slice(0, 2).map((type) => (
            <span
              key={type}
              className="rounded-full bg-zinc-100 px-2 py-0.5 text-[0.65rem] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            >
              {type}
            </span>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 text-[0.72rem]">
          <button
            type="button"
            onClick={() => onSelect?.(item.id)}
            disabled={!onSelect}
            aria-pressed={selected}
            aria-label={selected ? t("reference.card.unselect") : t("reference.card.select")}
            title={selected ? t("reference.selected.clear") : t("reference.card.select")}
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-1 transition-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${
              selected
                ? "text-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            <TargetIcon filled={selected} />
            <span className="sr-only">{selected ? t("reference.selected.clear") : t("reference.card.select")}</span>
          </button>
          <button
            type="button"
            onClick={() => onLike?.(item.id)}
            disabled={!onLike}
            aria-pressed={Boolean(like?.liked)}
            aria-label={
              like?.liked
                ? t("reference.card.unlikeAria", { n: like?.count ?? 0 })
                : t("reference.card.likeAria", { n: like?.count ?? 0 })
            }
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-1 transition-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${
              like?.liked
                ? "text-rose-600 dark:text-rose-300"
                : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            <HeartIcon filled={Boolean(like?.liked)} />
            <span className="tabular-nums">{like?.count ?? 0}</span>
          </button>
          <Link
            href={`/reference/${item.id}`}
            aria-label={t("reference.card.readFull")}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-zinc-500 transition-colors hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {t("reference.card.read")}
            <ArrowIcon />
          </Link>
        </div>
      </div>
    </article>
  );
}
