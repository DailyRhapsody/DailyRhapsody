"use client";

import { useEffect, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

/**
 * 拉取 /api/auth/session 判断是否管理员；返回 ok + loading。
 * refreshKey 变化时重新拉取：挂在根 layout 的组件不会随路由重建，登录后客户端跳转需要靠它刷新。
 */
export function useAdminSession(refreshKey?: unknown): { isAdmin: boolean; loading: boolean } {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetchWithTimeout("/api/auth/session", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { ok: false }))
      .then((data: { ok?: boolean }) => {
        if (!cancelled) setIsAdmin(!!data?.ok);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return { isAdmin, loading };
}
