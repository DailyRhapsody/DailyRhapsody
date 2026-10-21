"use client";

import Link from "next/link";
import type { KeyboardEvent, MouseEvent } from "react";
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

function ArrowIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

/** 卡片本身负责选中：不再单独放一个「选中」按钮。 */
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
  const preferredTitle = lang === "en" ? item.name || item.titleZh : item.titleZh || item.name;
  const displayName = preferredTitle?.trim() || t("reference.card.untitled");
  const sourceLabel = hostnameOf(item.url) || (item.source && item.source !== "手动添加" ? item.source : "");
  const tags = Array.from(
    new Set([
      ...(item.domains ?? []),
      ...(item.robotTypes ?? []),
      ...(item.company?.companyTags ?? []),
    ])
  ).slice(0, 4);

  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!onSelect) return;
    if ((event.target as HTMLElement).closest("a,button,input,select,textarea")) return;
    onSelect(item.id);
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onSelect) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if ((event.target as HTMLElement).closest("a,button,input,select,textarea")) return;
    event.preventDefault();
    onSelect(item.id);
  };

  return (
    <article
      aria-current={selected ? "true" : undefined}
      data-selected={selected || undefined}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      tabIndex={onSelect ? 0 : undefined}
      className="ap-ref-card focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
    >
      <div className="ap-ref-top">
        <span className="ap-ref-kind">{referenceKindLabel(item.kind, lang)}</span>
        <span className="ap-ref-source">
          {sourceLabel}
          {sourceLabel && item.year ? <span className="px-1 opacity-50">·</span> : null}
          {item.year || null}
        </span>
      </div>

      <h3 className="ap-ref-title">
        <Link href={`/reference/${item.id}`}>{displayName}</Link>
      </h3>

      {item.summary ? <p className="ap-ref-summary">{item.summary}</p> : null}

      {tags.length ? (
        <div className="ap-ref-tags">
          {tags.map((tag) => (
            <span key={tag} className="ap-ref-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      <div className="ap-ref-foot">
        <button
          type="button"
          onClick={() => onLike?.(item.id)}
          disabled={!onLike}
          aria-pressed={Boolean(like?.liked)}
          data-liked={like?.liked ? "true" : undefined}
          aria-label={
            like?.liked
              ? t("reference.card.unlikeAria", { n: like?.count ?? 0 })
              : t("reference.card.likeAria", { n: like?.count ?? 0 })
          }
          className="ap-ref-like focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
        >
          <HeartIcon filled={Boolean(like?.liked)} />
          <span className="tabular-nums">{like?.count ?? 0}</span>
        </button>
        <Link
          href={`/reference/${item.id}`}
          aria-label={t("reference.card.readFull")}
          className="ap-ref-read focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
        >
          {t("reference.card.read")}
          <ArrowIcon />
        </Link>
      </div>
    </article>
  );
}
