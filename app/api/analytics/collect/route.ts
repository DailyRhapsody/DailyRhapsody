import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recordVisit } from "@/lib/analytics-store";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import { resolveGeoForRequest } from "@/lib/geoip";
import {
  guardApiRequest,
  isLikelyBotUserAgent,
} from "@/lib/request-guard";
import { SCRAPE_GATE_COOKIE, verifyGateValue } from "@/lib/scrape-gate";

function normalizeVisitPath(raw: unknown): { path: string; queryString: string | null } | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t.startsWith("/") || t.length > 2048 || t.includes("\n") || t.includes("\r")) return null;
  const q = t.indexOf("?");
  if (q === -1) return { path: t.slice(0, 512), queryString: null };
  return {
    path: t.slice(0, q).slice(0, 512),
    queryString: t.slice(q + 1).slice(0, 1536) || null,
  };
}

function clip(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  return t.length <= max ? t : t.slice(0, max);
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 1 || n > 65535) return null;
  return n;
}

export async function POST(req: Request) {
  // analytics 是「fire-and-forget」最佳努力上报：任何分支都返回 204
  // 让前端不看到 console 红。
  // 不该计入的（管理员/无 gate/解析失败/存储故障）一律静默丢弃。

  // 管理员自身的浏览不计入统计
  if (await isAdmin()) return new NextResponse(null, { status: 204 });

  // 没有 dr_gate 视为脏数据，静默丢弃；不返回 403（避免污染前端 console）
  const gate = (await cookies()).get(SCRAPE_GATE_COOKIE)?.value;
  if (!verifyGateValue(gate)) {
    return new NextResponse(null, { status: 204 });
  }

  const blocked = await guardApiRequest(req, {
    scope: "analytics:collect",
    limit: 240,
    windowMs: 60_000,
    blockSuspicious: false,
    checkOrigin: false,
    checkSecFetch: false,
  });
  // guard 命中限流时返回 204 而不是 429，避免触发前端任何重试逻辑
  if (blocked) return new NextResponse(null, { status: 204 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const parsed = normalizeVisitPath(body.path);
  if (!parsed) return new NextResponse(null, { status: 204 });

  const ua = req.headers.get("user-agent");
  const isBot = isLikelyBotUserAgent(ua);
  const ip = getClientIpFromRequest(req);
  const geo = await resolveGeoForRequest(req, ip);

  try {
    await recordVisit({
      ip,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      latitude: geo.latitude,
      longitude: geo.longitude,
      path: parsed.path,
      queryString: parsed.queryString,
      referrer: clip(body.referrer, 2048),
      userAgent: ua ? ua.slice(0, 1024) : null,
      acceptLanguage:
        clip(req.headers.get("accept-language"), 256) || clip(body.language, 256),
      utmSource: clip(body.utmSource, 128),
      utmMedium: clip(body.utmMedium, 128),
      utmCampaign: clip(body.utmCampaign, 128),
      visitorId: clip(body.visitorId, 128),
      isBot,
      screenWidth: numOrNull(body.screenWidth),
      screenHeight: numOrNull(body.screenHeight),
    });
  } catch (e) {
    // 存储故障静默忽略：analytics 不应影响用户体验
    console.warn("[analytics] recordVisit failed:", e);
  }

  return new NextResponse(null, { status: 204 });
}
