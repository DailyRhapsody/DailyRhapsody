"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

export type ReferenceLikeState = { count: number; liked: boolean };

type Response = { likes?: Record<string, ReferenceLikeState> };

/**
 * 列表页的点赞数据层：一页只发一次批量请求，不在每张卡上各发一次。
 * 乐观更新失败会回滚；服务端返回的 count/liked 是最终值。
 */
export function useReferenceLikes(ids: string[]) {
  const [likes, setLikes] = useState<Record<string, ReferenceLikeState>>({});
  /** GateClient 完成握手后重拉一次：首访时 GET 可能先吃 403，不能把 0 当最终值 */
  const [gateGen, setGateGen] = useState(0);
  useEffect(() => {
    const onReady = () => setGateGen((g) => g + 1);
    window.addEventListener("dr-gate-ready", onReady);
    return () => window.removeEventListener("dr-gate-ready", onReady);
  }, []);
  const idsKey = useMemo(
    () => [...new Set(ids)].filter(Boolean).sort().join(","),
    [ids],
  );
  /** 用户手动点过的条目：批量响应回来时不要用更早的服务端值覆盖乐观结果 */
  const touchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!idsKey) return;
    let cancelled = false;
    const ids = idsKey.split(",").filter(Boolean);
    // 接口单次最多 30 条；无限滚动后总量会超过，按批取，避免后面的卡片永远显示 0
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));

    Promise.all(
      chunks.map((chunk) =>
        fetchWithTimeout(`/api/reference/likes?ids=${encodeURIComponent(chunk.join(","))}`)
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
          .catch(() => null),
      ),
    ).then((responses) => {
      if (cancelled) return;
      setLikes((prev) => {
        const next = { ...prev };
        for (const data of responses as (Response | null)[]) {
          if (!data?.likes) continue;
          for (const [id, state] of Object.entries(data.likes)) {
            // 请求在途时用户刚点过：保留本地值，别被更早的响应覆盖
            if (touchedRef.current.has(id)) continue;
            next[id] = state;
          }
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey, gateGen]);

  const toggle = useCallback(
    async (id: string) => {
      const current = likes[id] ?? { count: 0, liked: false };
      const nextLiked = !current.liked;
      touchedRef.current.add(id);
      const optimistic: ReferenceLikeState = {
        count: Math.max(0, current.count + (nextLiked ? 1 : -1)),
        liked: nextLiked,
      };
      setLikes((prev) => ({ ...prev, [id]: optimistic }));

      try {
        const res = await fetchWithTimeout(`/api/reference/${encodeURIComponent(id)}/like`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: nextLiked ? "like" : "unlike" }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ReferenceLikeState;
        if (typeof data?.count === "number") {
          setLikes((prev) => ({
            ...prev,
            [id]: { count: data.count, liked: Boolean(data.liked) },
          }));
        }
      } catch {
        // 回滚；如果期间又点了一次，以最新本地值为准会略偏，下一次批量拉取会校正
        setLikes((prev) => ({ ...prev, [id]: current }));
      }
    },
    [likes],
  );

  return { likes, toggle };
}
