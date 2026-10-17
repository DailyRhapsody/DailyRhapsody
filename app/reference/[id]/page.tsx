import Link from "next/link";
import { notFound } from "next/navigation";
import { getReferenceItem, isReferenceConfigured } from "@/lib/notion-reference";
import { isAdmin } from "@/lib/auth";
import { renderMarkdown, markdownHeadingClass, markdownPreviewProseClass } from "@/lib/markdown";

export const dynamic = "force-dynamic";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export default async function ReferenceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isReferenceConfigured()) notFound();
  const { id } = await params;
  const item = await getReferenceItem(id);
  if (!item) notFound();
  const admin = await isAdmin();
  if (!admin && item.isPublic === false) notFound();

  const sourceLabel = item.source || hostnameOf(item.url) || "";
  const renderedHtml = item.bodyMarkdown
    ? renderMarkdown(item.bodyMarkdown)
    : "";

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-100 to-white font-sans text-zinc-900 dark:from-black dark:via-zinc-950 dark:to-black dark:text-zinc-50">
      {/* 顶部固定 bar：返回 + 跳原文 */}
      <div className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 text-sm">
          <Link
            href="/reference"
            className="rounded text-zinc-700 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:ring-offset-white dark:text-zinc-300 dark:hover:text-zinc-50 dark:focus:ring-offset-zinc-900"
          >
            ← Reference
          </Link>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-blue-600 px-3 py-1.5 text-white shadow-sm transition-apple hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2"
            >
              跳到原文 ↗
            </a>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <header className="mb-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            {sourceLabel && (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {sourceLabel}
              </span>
            )}
            <span className="opacity-70">·</span>
            <span>收藏于 {formatDate(item.clippedAt)}</span>
          </div>
          <h1 className="mt-3 text-2xl font-bold leading-tight text-zinc-900 dark:text-zinc-50">
            {item.name || "(无标题)"}
          </h1>
          {item.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {item.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-zinc-200 px-2 py-0.5 text-[0.7rem] text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </header>

        {renderedHtml ? (
          // 收藏详情是长文阅读页：与博客展开态同一套标题层级，块间距也要显式给
          // （这里没有 EntrySummary 的 space-y 包裹）。
          <article className={`${markdownPreviewProseClass} ${markdownHeadingClass} text-[0.95rem] leading-relaxed`}>
            <div className="space-y-[1.15em]" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </article>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            正文为空。
            {item.url && (
              <>
                {" "}
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
                >
                  跳到原文阅读 ↗
                </a>
              </>
            )}
          </p>
        )}

        <footer className="mt-12 border-t border-zinc-200 pt-4 text-[0.7rem] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          本文为外部内容收藏，版权归原作者所有。
          {item.url && (
            <>
              {" 原文链接："}
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
              >
                {item.url}
              </a>
            </>
          )}
        </footer>
      </main>
    </div>
  );
}
