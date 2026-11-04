import { NextResponse } from "next/server";
import {
  guardApiRequest,
  isLikelyBotUserAgent,
  checkOriginOrReferer,
  withAntiScrapeHeaders,
} from "@/lib/request-guard";
import { getClientIpFromRequest } from "@/lib/client-ip";
import {
  mintSeedValue,
  SCRAPE_SEED_COOKIE,
  SEED_TTL_MS,
} from "@/lib/scrape-gate";

/**
 * 客户端握手时手上没有 dr_seed（挂起超过 5 分钟、只做过客户端跳转、页面不签发 seed、
 * 上次握手中止后丢弃了 seed），或 POST /api/gate/issue 因 IP bucket 不匹配返回 403 时，
 * 通过本端点在同一条 fetch 通道上获取绑定当前 IP 的 dr_seed，无需页面重载（lib/gate-handshake.ts）。安全模型与 middleware attachSeed 一致：
 *  — Sec-Fetch-Site/Mode/Dest 浏览器专属校验
 *  — Origin/Referer 同源
 *  — 速率限制 scope=gate:seed
 *
 * seed 获取本身不是防线 — gate 兑换才是。本端点不做 IP bucket 比较、
 * 不要求旧 seed，因为 middleware 签发 seed 同样不设这些条件。
 */
export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "gate:seed",
    limit: 20,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  const clientIp = getClientIpFromRequest(req);
  const ua = req.headers.get("user-agent");
  if (isLikelyBotUserAgent(ua)) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "请求被拒绝" }, { status: 403 })
    );
  }

  // 浏览器 fetch 必有的请求指纹
  const sfs = req.headers.get("sec-fetch-site");
  const sfm = req.headers.get("sec-fetch-mode");
  const sfd = req.headers.get("sec-fetch-dest");
  if (sfs !== "same-origin" || sfm !== "cors" || sfd !== "empty") {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "请求来源异常" }, { status: 403 })
    );
  }

  // Origin / Referer 必须同源
  if (!checkOriginOrReferer(req)) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "禁止跨域抓取" }, { status: 403 })
    );
  }

  // 签发新 seed（绑定当前 IP，与 middleware attachSeed 一致）
  const res = withAntiScrapeHeaders(NextResponse.json({ ok: true }));
  res.cookies.set(SCRAPE_SEED_COOKIE, mintSeedValue(clientIp), {
    httpOnly: false,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(SEED_TTL_MS / 1000),
  });
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  res.headers.set("CDN-Cache-Control", "no-store");
  res.headers.set("Vercel-CDN-Cache-Control", "no-store");
  return res;
}
