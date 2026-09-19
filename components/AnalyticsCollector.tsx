"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const STORAGE_KEY = "dr_visit_vid";
const DEBOUNCE_MS = 2500;

function getOrCreateVisitorId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

function utmFromLocation(): {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
} {
  if (typeof window === "undefined") return {};
  try {
    const u = new URL(window.location.href);
    const utmSource = u.searchParams.get("utm_source") ?? undefined;
    const utmMedium = u.searchParams.get("utm_medium") ?? undefined;
    const utmCampaign = u.searchParams.get("utm_campaign") ?? undefined;
    return { utmSource, utmMedium, utmCampaign };
  } catch {
    return {};
  }
}

/** 同一页的两个 tab：/blog ↔ /moments 切换只改地址栏，不算一次新的访问 */
const SAME_PAGE_TABS = new Set(["/blog", "/moments"]);

export function AnalyticsCollector() {
  const pathname = usePathname();
  const lastRef = useRef<{ key: string; t: number }>({ key: "", t: 0 });
  const prevPathRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevPathRef.current;
    prevPathRef.current = pathname;
    if (!pathname || pathname.startsWith("/admin")) return;
    if (prev && prev !== pathname && SAME_PAGE_TABS.has(prev) && SAME_PAGE_TABS.has(pathname)) return;

    const search = typeof window !== "undefined" ? window.location.search || "" : "";
    const hash = typeof window !== "undefined" ? window.location.hash || "" : "";
    const pathKey = pathname + search + (hash && hash !== "#" ? hash : "");
    const now = Date.now();
    if (lastRef.current.key === pathKey && now - lastRef.current.t < DEBOUNCE_MS) return;
    lastRef.current = { key: pathKey, t: now };

    const visitorId = getOrCreateVisitorId();
    const utm = utmFromLocation();
    const body = JSON.stringify({
      path: pathKey,
      referrer: typeof document !== "undefined" ? document.referrer || null : null,
      visitorId,
      screenWidth: typeof window !== "undefined" ? window.screen.width : null,
      screenHeight: typeof window !== "undefined" ? window.screen.height : null,
      language: typeof navigator !== "undefined" ? navigator.language : null,
      ...utm,
    });

    const url = "/api/analytics/collect";
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(url, blob);
      if (ok) return;
    }
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }, [pathname]);

  return null;
}
