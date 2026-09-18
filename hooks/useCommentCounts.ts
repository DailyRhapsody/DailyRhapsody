"use client";

import { useSyncExternalStore } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

/**
 * 各篇评论数：整页共用一份，第一张卡片订阅时拉一次 /api/diaries/comment-counts。
 * 每张卡片只订阅自己那篇的数字；线程拉到、发表、删除后由线程同步回来，不必整份重拉。
 */
let counts: Readonly<Record<string, number>> = {};
let state: "idle" | "loading" | "done" = "idle";
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function load() {
  if (state !== "idle") return;
  state = "loading";
  fetchWithTimeout("/api/diaries/comment-counts")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data: { counts?: Record<string, number> }) => {
      const server = data?.counts ?? {};
      // 请求在途时线程已同步过的数字（刚发表的评论），服务端返回里可能还没算上：取两者较大值
      const merged: Record<string, number> = { ...server };
      for (const [id, n] of Object.entries(counts)) merged[id] = Math.max(n, server[id] ?? 0);
      counts = merged;
      state = "done";
      emit();
    })
    .catch(() => {
      // 失败不缓存结果：gate 就绪或下一张卡片订阅时再试
      state = "idle";
    });
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  load();
  if (listeners.size === 1) window.addEventListener("dr-gate-ready", load);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) window.removeEventListener("dr-gate-ready", load);
  };
}

export function useCommentCount(diaryId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => counts[diaryId] ?? 0,
    () => 0
  );
}

/** 线程拉到的真实条数与计数不一致时（计数漂移、别人刚发了评论）以线程为准 */
export function syncCommentCount(diaryId: string, n: number) {
  if ((counts[diaryId] ?? 0) === n) return;
  counts = { ...counts, [diaryId]: n };
  emit();
}
