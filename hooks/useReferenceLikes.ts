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
  const idsKey = useMemo(
    () => [...new Set(ids)].filter(Boolean).sort().join(","),
    [ids],
  );
  /** 用户手动点过的条目：批量响应回来时不要用更早的服务端值覆盖乐观结果 */
  const touchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!idsKey) return;
    let cancelled = false;
    fetchWithTimeout(`/api/reference/likes?ids=${encodeURIComponent(idsKey)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: Response) => {
        if (cancelled || !data?.likes) return;
        setLikes((prev) => {
          const next = { ...prev };
          for (const [id, state] of Object.entries(data.likes!)) {
            // 请求在途时用户刚点过：保留本地值，别被更早的响应覆盖
            if (touchedRef.current.has(id)) continue;
            next[id] = state;
          }
          return next;
        });
      })
      .catch(() => {
        // gate 未就绪/限流：保留下一次机会，不把 0 写成最终态
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

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
