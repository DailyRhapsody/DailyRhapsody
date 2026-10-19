"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { ReferenceListItem } from "@/hooks/useReference";
import type { ReferenceLikeState } from "@/hooks/useReferenceLikes";

const KIND_META: Record<
  ReferenceListItem["kind"],
  { label: string; gradient: string; text: string }
> = {
  external: {
    label: "外部资料",
    gradient: "from-sky-100 via-zinc-100 to-white dark:from-sky-950/60 dark:via-zinc-900 dark:to-zinc-950",
    text: "text-sky-700 dark:text-sky-300",
  },
  commentary: {
    label: "行业评论",
    gradient: "from-amber-100 via-zinc-100 to-white dark:from-amber-950/60 dark:via-zinc-900 dark:to-zinc-950",
    text: "text-amber-700 dark:text-amber-300",
  },
  test: {
    label: "实测报告",
    gradient: "from-emerald-100 via-zinc-100 to-white dark:from-emerald-950/60 dark:via-zinc-900 dark:to-zinc-950",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  interview: {
    label: "访谈",
    gradient: "from-violet-100 via-zinc-100 to-white dark:from-violet-950/60 dark:via-zinc-900 dark:to-zinc-950",
    text: "text-violet-700 dark:text-violet-300",
  },
};

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
  const cls = "h-4 w-4";
  if (kind === "commentary") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 7H6a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v3l4-3V9a2 2 0 0 0-2-2Zm9 0h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v3l4-3V9a2 2 0 0 0-2-2Z" />
      </svg>
    );
  }
  if (kind === "test") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 19h16M7 16V9m5 7V5m5 11v-4" />
      </svg>
    );
  }
  if (kind === "interview") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Zm-6 8a6 6 0 0 0 12 0M12 18v3m-3 0h6" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l4 4v14H7V3Zm7 0v5h4M9.5 12h6M9.5 15.5h6" />
    </svg>
  );
}

export function ReferenceCard({
  item,
  like,
  onLike,
}: {
  item: ReferenceListItem;
  like?: ReferenceLikeState;
  onLike?: (id: string) => void;
}) {
  const meta = KIND_META[item.kind] ?? KIND_META.external;
  const displayName = item.titleZh?.trim() || item.name || "(无标题)";
  const sourceLabel = item.source || hostnameOf(item.url) || "";
  const hasCover = Boolean(item.coverPath);
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = hasCover && !coverFailed;

  return (
    <article
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white/70 shadow-sm transition-apple hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700"
    >
      <Link
        href={`/reference/${item.id}`}
        className="relative block aspect-[16/10] overflow-hidden bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:bg-zinc-800"
        aria-label={displayName || "参考条目"}
      >
        {showCover && item.coverKind === "file" ? (
          <Image
            src={item.coverPath!}
            alt=""
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 33vw"
            className="object-cover transition-apple group-hover:scale-[1.02]"
            onError={() => setCoverFailed(true)}
          />
        ) : showCover && item.coverKind === "external" ? (
          // 外链封面域名不可枚举，不能用 next/image 的 remotePatterns；
          // 用原生 img 并限制在固定比例容器里，避免布局抖动。
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.coverPath!}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover transition-apple group-hover:scale-[1.02]"
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <div
            className={`flex h-full w-full items-end justify-between bg-gradient-to-br p-4 ${meta.gradient}`}
          >
            <span
              className={`inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/70 shadow-sm dark:bg-zinc-950/50 ${meta.text}`}
            >
              <KindIcon kind={item.kind} />
            </span>
            <span className={`text-[0.7rem] font-medium tracking-wide ${meta.text}`}>
              {meta.label}
            </span>
          </div>
        )}
        <span
          className={`absolute left-3 top-3 rounded-full bg-white/85 px-2 py-0.5 text-[0.65rem] font-medium backdrop-blur dark:bg-zinc-950/70 ${meta.text}`}
        >
          {meta.label}
        </span>
      </Link>

      <div className="flex flex-1 flex-col px-4 pb-4 pt-3">
        <div className="flex items-center gap-2 text-[0.7rem] text-zinc-500 dark:text-zinc-400">
          {sourceLabel && <span className="truncate">{sourceLabel}</span>}
          {sourceLabel && item.year ? <span className="opacity-60">·</span> : null}
          {item.year ? <span>{item.year}</span> : null}
        </div>

        <h3 className="mt-1.5 text-base font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
          <Link
            href={`/reference/${item.id}`}
            className="line-clamp-2 rounded transition-colors hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:hover:text-blue-300"
          >
            {displayName}
          </Link>
        </h3>

        {item.summary ? (
          <p className="mt-1.5 line-clamp-3 text-[0.8rem] leading-relaxed text-zinc-600 dark:text-zinc-400">
            {item.summary}
          </p>
        ) : null}

        {item.domains.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {item.domains.slice(0, 2).map((d) => (
              <span
                key={d}
                className="rounded-full border border-zinc-200 px-2 py-0.5 text-[0.65rem] text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
              >
                {d}
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-[0.75rem]">
          <button
            type="button"
            onClick={() => onLike?.(item.id)}
            disabled={!onLike}
            aria-pressed={Boolean(like?.liked)}
            aria-label={
              like?.liked
                ? `取消点赞，当前 ${like?.count ?? 0} 人觉得有用`
                : `点赞，当前 ${like?.count ?? 0} 人觉得有用`
            }
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 transition-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${
              like?.liked
                ? "bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            <HeartIcon filled={Boolean(like?.liked)} />
            <span className="tabular-nums">{like?.count ?? 0}</span>
          </button>

          <div className="flex items-center gap-2">
            <Link
              href={`/reference/${item.id}`}
              className="rounded text-zinc-600 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              站内阅读
            </Link>
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded text-zinc-500 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                原文 ↗
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}
