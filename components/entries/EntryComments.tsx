"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { syncCommentCount } from "@/hooks/useCommentCounts";
import { useCommentIdentity } from "@/hooks/useCommentIdentity";
import { loadCommentThread, updateCachedThread } from "@/lib/comment-threads";
import { COMMENT_AVATAR_COUNT, CommentAvatar } from "./CommentAvatar";
import { DefaultAvatar } from "./DefaultAvatar";
import type { Comment } from "./types";

const MAX_CONTENT = 2000;
const MAX_NAME = 32;
const TEXTAREA_MAX_PX = 160;

/** 旧评论没有头像字段：按 id 固定挑一个 */
function avatarOf(c: Comment): number {
  if (c.avatar) return c.avatar;
  let h = 0;
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 1 + (h % COMMENT_AVATAR_COUNT);
}

function formatCommentTime(iso: string): string {
  const t = new Date(iso);
  const ms = t.getTime();
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (t >= yesterday) {
    return `昨天 ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  }
  if (t.getFullYear() === now.getFullYear()) return `${t.getMonth() + 1}月${t.getDate()}日`;
  return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`;
}

function BubbleIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 18.5 4 20l1.2-3.6A7.5 7.5 0 1 1 7.5 18.5Z"
      />
    </svg>
  );
}

export { BubbleIcon as CommentBubbleIcon };

export type EntryCommentsProps = {
  diaryId: string;
  /** 计数接口给的评论数；与拉到的线程不一致时以线程为准 */
  count: number;
  /** margin：宽屏正文右侧，类 Notion 旁注；inline：窄屏在文章下方展开 */
  variant: "margin" | "inline";
  /** 线程最高不超过文章本身；超出时评论列表折叠 */
  maxHeight: number;
  /** 读者刚点了「评论」：聚焦输入框一次，随后调 onAutoFocused 清掉，重挂载时不再抢焦点 */
  autoFocus: boolean;
  onAutoFocused: () => void;
  /** 关掉线程：inline 的「收起」；没有评论时的「取消」/ 点到别处 */
  onClose: () => void;
  canEdit: boolean;
  authorName: string;
  authorAvatarSrc: string;
};

function mergeThread(fetched: Comment[], local: Comment[] | null, posted: Set<string>): Comment[] {
  // 读取在途时刚发表的评论，返回结果里可能还没有：保留下来
  const extra = (local ?? []).filter((c) => posted.has(c.id) && !fetched.some((f) => f.id === c.id));
  if (extra.length === 0) return fetched;
  return [...fetched, ...extra].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
}

/**
 * 文章评论线程（类 Notion 评论）：头像 + 昵称 + 相对时间，头像之间竖线相连；
 * 输入框在下，昵称可选、写在输入框下面；访客头像从头像库随机，点头像可换。
 */
export function EntryComments({
  diaryId,
  count,
  variant,
  maxHeight,
  autoFocus,
  onAutoFocused,
  onClose,
  canEdit,
  authorName,
  authorAvatarSrc,
}: EntryCommentsProps) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  /** 评论列表的最高高度：线程总高不超过 maxHeight，扣掉输入框等固定部分后留给列表的空间 */
  const [listMax, setListMax] = useState(maxHeight);
  // 宽屏旁注按需拉取：线程接近视口才请求，不在首屏把每篇的评论都拉一遍
  const [near, setNear] = useState(variant === "inline");
  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const hasDraftRef = useRef(false);
  const scrollToEndRef = useRef(false);
  const postedRef = useRef(new Set<string>());

  useEffect(() => {
    if (near) return;
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    loadCommentThread(diaryId, { fresh: reloadKey > 0 })
      .then((fetched) => {
        if (cancelled) return;
        setLoadFailed(false);
        setComments((prev) => mergeThread(fetched, prev, postedRef.current));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [near, diaryId, reloadKey]);

  // 线程变了（拉到、发表、删除）就同步计数与缓存：计数以线程为准，重挂载时读到的是最新线程
  useEffect(() => {
    if (comments === null) return;
    syncCommentCount(diaryId, comments.length);
    updateCachedThread(diaryId, comments);
  }, [comments, diaryId]);

  const list = comments ?? [];
  // 还没有任何评论的线程（含加载中、加载失败）可以直接关掉；有评论的线程常驻
  const dismissable = list.length === 0 && count === 0;

  // 点到线程外面就收起空线程。用 click 而不是失焦：Safari 点按钮不给焦点，失焦判断会把
  // 线程里的点击当成点到外面；在 pointerdown 时收起又会让下面的文章上移，这次点击落空。
  // 捕获阶段注册：打开线程的那次点击冒泡到 document 时不会被当成「点到外面」
  useEffect(() => {
    if (!dismissable) return;
    function onClick(e: MouseEvent) {
      if (hasDraftRef.current) return;
      if (rootRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dismissable, onClose]);

  // 线程总高不超过 maxHeight：量出列表以外部分（输入框、展开按钮、内边距）的高度，剩下的给列表
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const chrome = root.offsetHeight - (listRef.current?.offsetHeight ?? 0);
      const next = Math.max(Math.round(maxHeight - chrome), 48);
      setListMax((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [maxHeight]);

  // 评论列表是否超出可用高度：超出才显示「展开 / 收起」
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) {
      setOverflowing(false);
      return;
    }
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [comments, listMax, expanded]);

  // 刚发表的评论落在折叠区外时，展开并滚到最后一条
  useEffect(() => {
    if (!scrollToEndRef.current) return;
    const el = listRef.current;
    if (!el) return;
    if (el.scrollHeight > el.clientHeight + 1 && !expanded) {
      setExpanded(true);
      return;
    }
    scrollToEndRef.current = false;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [comments, expanded]);

  function toggleExpanded() {
    // 收起时回到第一条：overflow 改成 hidden 不会重置滚动位置，否则折叠后停在中间、前几条看不到
    if (expanded && listRef.current) listRef.current.scrollTop = 0;
    setExpanded((v) => !v);
  }

  function handlePosted(c: Comment) {
    scrollToEndRef.current = true;
    postedRef.current.add(c.id);
    setComments((prev) => [...(prev ?? []), c]);
  }

  async function handleDelete(c: Comment) {
    if (!window.confirm(`删除「${c.author}」的这条评论？`)) return;
    try {
      const res = await fetchWithTimeout(
        `/api/diaries/${encodeURIComponent(diaryId)}/comments/${encodeURIComponent(c.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      setComments((prev) => (prev ?? []).filter((x) => x.id !== c.id));
    } catch {
      window.alert("删除失败，请稍后再试");
    }
  }

  return (
    <section
      ref={rootRef}
      aria-label="评论"
      onBlur={(e) => {
        // 键盘 Tab 到线程外：同样收起空线程（鼠标点击由上面的 click 监听处理）
        const next = e.relatedTarget as Node | null;
        if (!dismissable || hasDraftRef.current || !next) return;
        if (!rootRef.current?.contains(next)) onClose();
      }}
      className={`flex flex-col text-left ${
        variant === "margin"
          ? "rounded-xl bg-white/90 p-3 shadow-sm ring-1 ring-zinc-900/5 backdrop-blur-md dark:bg-zinc-900/85 dark:ring-white/10"
          : "rounded-xl bg-zinc-50/80 p-3 ring-1 ring-zinc-900/5 dark:bg-zinc-800/40 dark:ring-white/10"
      }`}
    >
      {variant === "inline" && (
        <div className="mb-2 flex items-center justify-between text-[0.72rem] text-zinc-500 dark:text-zinc-400">
          <span className="flex items-center gap-1">
            <BubbleIcon />
            评论{list.length > 0 ? ` · ${list.length}` : ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            收起
          </button>
        </div>
      )}

      {comments === null && !loadFailed && count > 0 && (
        <p className="py-1 text-[0.72rem] text-zinc-400">加载中…</p>
      )}
      {loadFailed && (
        <p className="py-1 text-[0.72rem] text-zinc-400">
          评论加载失败，
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="underline underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            重试
          </button>
        </p>
      )}

      {list.length > 0 && (
        <>
          <ol
            ref={listRef}
            style={{ maxHeight: listMax }}
            className={
              expanded
                ? "overflow-y-auto overscroll-contain [scrollbar-width:thin]"
                : `overflow-hidden ${
                    overflowing
                      ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]"
                      : ""
                  }`
            }
          >
            {list.map((c, i) => (
              <CommentItem
                key={c.id}
                comment={c}
                last={i === list.length - 1}
                canEdit={canEdit}
                authorAvatarSrc={authorAvatarSrc}
                onDelete={handleDelete}
              />
            ))}
          </ol>
          {overflowing && (
            <button
              type="button"
              onClick={toggleExpanded}
              className="mt-1 w-fit text-[0.72rem] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              {expanded ? "收起" : `展开全部 ${list.length} 条`}
            </button>
          )}
        </>
      )}

      <CommentComposer
        diaryId={diaryId}
        divided={list.length > 0}
        autoFocus={autoFocus}
        onAutoFocused={onAutoFocused}
        canEdit={canEdit}
        authorName={authorName}
        authorAvatarSrc={authorAvatarSrc}
        showCancel={dismissable}
        onCancel={onClose}
        onDraftChange={(has) => {
          hasDraftRef.current = has;
        }}
        onPosted={handlePosted}
      />
    </section>
  );
}

function CommentItem({
  comment: c,
  last,
  canEdit,
  authorAvatarSrc,
  onDelete,
}: {
  comment: Comment;
  last: boolean;
  canEdit: boolean;
  authorAvatarSrc: string;
  onDelete: (c: Comment) => void;
}) {
  const full = new Date(c.createdAt).toLocaleString("zh-CN", { hour12: false });
  return (
    <li className={`group/comment relative flex gap-2 ${last ? "pb-1" : "pb-3"}`}>
      {/* 头像之间的竖线，把同一篇的评论串成一条线程 */}
      {!last && (
        <span
          aria-hidden
          className="absolute bottom-0.5 left-3 top-7 w-px -translate-x-1/2 bg-zinc-200 dark:bg-zinc-700"
        />
      )}
      {c.isAuthor ? (
        <DefaultAvatar src={authorAvatarSrc} className="h-6 w-6" />
      ) : (
        <CommentAvatar n={avatarOf(c)} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5 leading-6">
          <span className="truncate text-[0.78rem] font-medium text-zinc-800 dark:text-zinc-200">
            {c.author}
          </span>
          {c.isAuthor && (
            <span className="shrink-0 rounded bg-zinc-200/70 px-1 text-[0.62rem] leading-4 text-zinc-500 dark:bg-zinc-700/70 dark:text-zinc-400">
              作者
            </span>
          )}
          <time
            dateTime={c.createdAt}
            title={full}
            className="shrink-0 text-[0.68rem] text-zinc-400 dark:text-zinc-500"
          >
            {formatCommentTime(c.createdAt)}
          </time>
          {canEdit && (
            <button
              type="button"
              onClick={() => onDelete(c)}
              aria-label="删除评论"
              title="删除评论"
              className="ml-auto shrink-0 self-center rounded p-0.5 text-zinc-400 opacity-0 transition-apple hover:text-red-500 focus-visible:opacity-100 group-hover/comment:opacity-100"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 7h14M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
              </svg>
            </button>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words text-[0.8rem] leading-relaxed text-zinc-700 dark:text-zinc-300">
          {c.content}
        </p>
      </div>
    </li>
  );
}

function CommentComposer({
  diaryId,
  divided,
  autoFocus,
  onAutoFocused,
  canEdit,
  authorName,
  authorAvatarSrc,
  showCancel,
  onCancel,
  onDraftChange,
  onPosted,
}: {
  diaryId: string;
  divided: boolean;
  autoFocus: boolean;
  onAutoFocused: () => void;
  canEdit: boolean;
  authorName: string;
  authorAvatarSrc: string;
  showCancel: boolean;
  onCancel: () => void;
  onDraftChange: (hasDraft: boolean) => void;
  onPosted: (c: Comment) => void;
}) {
  const [content, setContent] = useState("");
  const { name, avatar, setName, shuffleAvatar } = useCommentIdentity();
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);
  const active = focused || content !== "";

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus();
    onAutoFocused();
  }, [autoFocus, onAutoFocused]);

  useEffect(() => {
    onDraftChange(content.trim() !== "");
  }, [content, onDraftChange]);

  // 输入框随内容长高，最多约 6 行
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, TEXTAREA_MAX_PX)}px`;
  }, [content]);

  async function submit() {
    const text = content.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/diaries/${encodeURIComponent(diaryId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          author: name.trim(),
          content: text,
          avatar,
          website: honeypotRef.current?.value ?? "",
        }),
      });
      const data = (await res.json().catch(() => null)) as (Comment & { error?: string }) | null;
      if (!res.ok || !data?.id) {
        setError(data?.error || "发送失败，请稍后再试");
        return;
      }
      setContent("");
      onPosted(data);
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!formRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className={`relative flex shrink-0 items-start gap-2 ${
        divided ? "mt-2 border-t border-zinc-900/5 pt-2.5 dark:border-white/10" : ""
      }`}
    >
      {canEdit ? (
        <DefaultAvatar src={authorAvatarSrc} className="h-6 w-6" />
      ) : (
        <button
          type="button"
          onClick={shuffleAvatar}
          title="换一个头像"
          aria-label="换一个头像"
          className="shrink-0 rounded-full transition-apple hover:scale-110 hover:ring-2 hover:ring-zinc-300 dark:hover:ring-zinc-600"
        >
          <CommentAvatar n={avatar} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            // 输入法候选框打开时的回车 / Esc 属于输入法（确认、取消候选），不当作发送或关闭
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape") {
              e.currentTarget.blur();
              if (!content && showCancel) onCancel();
              return;
            }
            if (e.key !== "Enter") return;
            // 桌面端回车发送、Shift+回车换行（同 Notion）；触屏回车换行，用按钮发送
            const send =
              e.metaKey ||
              e.ctrlKey ||
              (!e.shiftKey && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
            if (!send) return;
            e.preventDefault();
            void submit();
          }}
          rows={1}
          maxLength={MAX_CONTENT}
          // 全局 :focus-visible 黑框是未分层样式，工具类盖不住；输入框有光标和展开的昵称栏，不需要再描边
          style={{ outline: "none" }}
          placeholder={divided ? "回复…" : "添加评论…"}
          aria-label="评论内容"
          className="block min-h-6 w-full resize-none bg-transparent py-0.5 text-[0.8rem] leading-5 text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        {active && (
          <div className="mt-1.5 flex items-center gap-2">
            {canEdit ? (
              <span className="min-w-0 flex-1 truncate text-[0.7rem] text-zinc-400">
                以 {authorName} 的身份评论
              </span>
            ) : (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME}
                style={{ outline: "none" }}
                placeholder="昵称（可不填）"
                aria-label="昵称（可不填）"
                autoComplete="nickname"
                className="min-w-0 flex-1 rounded-md bg-zinc-100/80 px-2 py-1 text-[0.72rem] text-zinc-700 outline-none ring-zinc-300 placeholder:text-zinc-400 focus:ring-1 dark:bg-zinc-800/80 dark:text-zinc-200 dark:ring-zinc-600"
              />
            )}
            {showCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="shrink-0 rounded px-1.5 py-1 text-[0.72rem] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                取消
              </button>
            )}
            <button
              type="submit"
              disabled={!content.trim() || submitting}
              aria-label="发送"
              title="发送（回车）"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-zinc-900 text-white transition-apple hover:bg-zinc-700 disabled:bg-zinc-200 disabled:text-zinc-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500"
            >
              {submitting ? (
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" aria-hidden>
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="32 24" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M6 11l6-6 6 6" />
                </svg>
              )}
            </button>
          </div>
        )}
        {error && <p className="mt-1 text-[0.7rem] text-red-500 dark:text-red-400">{error}</p>}
        {/* 蜜罐：真人看不到也聚焦不到，脚本按字段名填了就会被服务端拒收 */}
        <input
          ref={honeypotRef}
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          className="pointer-events-none absolute -left-[9999px] h-px w-px opacity-0"
        />
      </div>
    </form>
  );
}
