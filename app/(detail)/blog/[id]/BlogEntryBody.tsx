"use client";

import { useEffect, useState } from "react";
import type { Diary } from "@/components/entries/types";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { entrySummaryProseClass, renderMarkdown } from "@/lib/markdown";

type BodyState =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "missing" }
  | { status: "failed" };

/**
 * 单篇文章页的正文：握手完成后从 /api/diaries/[id] 读取，在浏览器里渲染。
 *
 * 正文不能由服务端直出。这个页面不要求握手，而文章 id 不是秘密：思维大树的
 * public/tree/tree.json 与 v15-oak.html 的内嵌快照列着全部公开文章的 id，静态文件又不经过
 * proxy。页面直出正文，脚本不握手就能按 id 逐篇取走全站正文。/api/diaries/[id] 受门闸保护；
 * 握手还没完成时拿到的 403 由 fetchWithTimeout 等 dr-gate-ready 后重试。
 */
export function BlogEntryBody({ id }: { id: string }) {
  const [state, setState] = useState<BodyState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      let next: BodyState;
      try {
        const res = await fetchWithTimeout(`/api/diaries/${encodeURIComponent(id)}`, {
          headers: { accept: "application/json" },
          signal: ctrl.signal,
        });
        if (res.status === 404) {
          next = { status: "missing" };
        } else if (!res.ok) {
          next = { status: "failed" };
        } else {
          const diary = (await res.json()) as Pick<Diary, "summary">;
          // 开头与页面标题重复的一级标题不渲染（与改动前的服务端渲染一致）
          const body = (diary.summary ?? "").replace(/^#\s+[^\n]*\n+/, "");
          next = { status: "ready", html: renderMarkdown(body) };
        }
      } catch {
        next = { status: "failed" };
      }
      // 卸载或换文章时已中止的请求不再写状态
      if (!ctrl.signal.aborted) setState(next);
    })();
    return () => ctrl.abort();
  }, [id, reloadKey]);

  if (state.status === "ready") {
    return (
      <article
        className={`${entrySummaryProseClass(true)} mt-8 text-[0.95rem]`}
        dangerouslySetInnerHTML={{ __html: state.html }}
      />
    );
  }

  if (state.status === "loading") {
    return (
      <div className="mt-8 space-y-3" role="status" aria-label="正文加载中">
        {["w-full", "w-11/12", "w-4/5"].map((width) => (
          <div key={width} className={`h-4 ${width} animate-pulse rounded bg-zinc-100 dark:bg-zinc-800`} />
        ))}
      </div>
    );
  }

  if (state.status === "missing") {
    return <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">这篇文章不存在或已删除</p>;
  }

  return (
    <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">
      正文加载失败，
      <button
        type="button"
        onClick={() => {
          setState({ status: "loading" });
          setReloadKey((k) => k + 1);
        }}
        className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-200"
      >
        重试
      </button>
    </p>
  );
}
