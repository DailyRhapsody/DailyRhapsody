"use client";

import { useEffect, useRef, useState } from "react";
import { CommentAvatar } from "@/components/entries/CommentAvatar";
import { useCommentIdentity } from "@/hooks/useCommentIdentity";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type { ReferenceComment } from "@/lib/reference-comments";

function formatTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function ReferenceComments({ threadId }: { threadId: string }) {
  const [comments, setComments] = useState<ReferenceComment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const { name, avatar, setName, shuffleAvatar } = useCommentIdentity();
  const honeypotRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchWithTimeout(`/api/reference/comments?ids=${encodeURIComponent(threadId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { threads?: Record<string, ReferenceComment[]> }) => {
        if (cancelled) return;
        setComments(Array.isArray(data.threads?.[threadId]) ? data.threads[threadId] : []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = content.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetchWithTimeout(`/api/reference/${encodeURIComponent(threadId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          author: name,
          content: text,
          avatar,
          website: honeypotRef.current?.value ?? "",
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `发表失败（${res.status}）`);
      }
      const comment = (await res.json()) as ReferenceComment;
      setComments((prev) => [...(prev ?? []), comment]);
      setContent("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "发表失败，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-10 border-t border-zinc-200 pt-6 dark:border-zinc-800" aria-label="评论">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          评论
          {comments && comments.length > 0 ? (
            <span className="ml-1.5 text-xs font-normal text-zinc-400">{comments.length}</span>
          ) : null}
        </h2>
        <span className="text-[0.7rem] text-zinc-400 dark:text-zinc-500">匿名，留个昵称即可</span>
      </div>

      {failed ? (
        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          评论暂时加载失败。
        </p>
      ) : comments === null ? (
        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">加载中…</p>
      ) : comments.length === 0 ? (
        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          还没有评论。对这篇资料有补充或不同意见，可以直接写。
        </p>
      ) : (
        <ol className="mt-4 space-y-4">
          {comments.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <CommentAvatar n={c.avatar ?? 1} className="mt-0.5 h-7 w-7" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2 text-[0.7rem]">
                  <span className={`font-medium ${c.isAuthor ? "text-blue-600 dark:text-blue-400" : "text-zinc-700 dark:text-zinc-200"}`}>
                    {c.author}
                    {c.isAuthor ? " · 站长" : ""}
                  </span>
                  <span className="text-zinc-400 dark:text-zinc-500">{formatTime(c.createdAt)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-[0.85rem] leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {c.content}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={submit} className="mt-5 rounded-xl border border-zinc-200 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="写下补充、质疑或实测数据…"
          className="w-full resize-none bg-transparent text-sm leading-relaxed text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        {/* 蜜罐：真人看不见，脚本按字段名填了会被服务端拒收 */}
        <input
          ref={honeypotRef}
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          className="absolute -left-[9999px] h-0 w-0 opacity-0"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <button
            type="button"
            onClick={shuffleAvatar}
            title="换一个头像"
            className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            <CommentAvatar n={avatar} className="h-6 w-6" />
          </button>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            placeholder="昵称（可选）"
            className="w-28 rounded-md border border-zinc-200 bg-white/70 px-2 py-1 text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200"
          />
          <span className="ml-auto text-[0.7rem] text-zinc-400">{content.length}/1000</span>
          <button
            type="submit"
            disabled={submitting || content.trim().length === 0}
            className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white transition-apple hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {submitting ? "发表中…" : "发表"}
          </button>
        </div>
        {submitError ? <p className="mt-2 text-[0.7rem] text-rose-600 dark:text-rose-400">{submitError}</p> : null}
      </form>
    </section>
  );
}
