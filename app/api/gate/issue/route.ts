import { NextResponse } from "next/server";
import { markNonceUsed, recordViolation } from "@/lib/honeypot";
import {
  checkPow,
  POW_DIFFICULTY,
  SCRAPE_SEED_COOKIE,
  setGateCookies,
  verifySeedValue,
} from "@/lib/scrape-gate";
import {
  checkOriginOrReferer,
  guardApiRequest,
  isLikelyBotUserAgent,
  withAntiScrapeHeaders,
} from "@/lib/request-guard";
import { getClientIpFromRequest } from "@/lib/client-ip";

/**
 * 客户端用 fetch 二次握手换取 dr_gate cookie。
 *
 * 强校验项（任何一项失败立即 403）：
 *  - 必须是 POST。
 *  - User-Agent 不能是已知爬虫关键字。
 *  - Sec-Fetch-Site 必须是 same-origin（浏览器自动发送，curl/requests 默认无）。
 *  - Sec-Fetch-Mode 必须是 cors。
 *  - Sec-Fetch-Dest 必须是 empty。
 *  - Origin / Referer 必须同源（不再放行"两者皆无"）。
 *  - 必须持有有效 dr_seed cookie（在合法页面访问后由中间件签发，5 分钟有效）。
 *  - PoW 校验通过：sha256(seedNonce + ":" + counter) 前 N 位为 0。
 *
 * 多次失败由速率限制 + honeypot 计入 IP 黑名单。
 */
export async function POST(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "gate:issue",
    limit: 12,
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

  // 浏览器 fetch 必有的请求指纹：服务器侧 fetch / curl / requests 默认全部缺失
  const sfs = req.headers.get("sec-fetch-site");
  const sfm = req.headers.get("sec-fetch-mode");
  const sfd = req.headers.get("sec-fetch-dest");
  if (sfs !== "same-origin" || sfm !== "cors" || sfd !== "empty") {
    // 不再 blockIp：Surge MITM 等代理可能篡改 Sec-Fetch-* 头，
    // 一次失败就封 24h 会误伤真人。改为 recordViolation 计数，到阈值再封。
    await recordViolation(clientIp, `gate/issue bad sec-fetch sfs=${sfs} sfm=${sfm} sfd=${sfd}`, req.headers);
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "请求来源异常" }, { status: 403 })
    );
  }

  // Origin / Referer 必须同源（这里强校验：必须存在）
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (!origin && !referer) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "缺少同源标识" }, { status: 403 })
    );
  }
  if (!checkOriginOrReferer(req)) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "禁止跨域抓取" }, { status: 403 })
    );
  }

  // 必须先持有有效 seed cookie（即必须先访问过页面）
  const cookieHeader = req.headers.get("cookie") ?? "";
  const seedRaw = cookieHeader
    .split(/;\s*/)
    .map((kv) => kv.split("="))
    .find(([k]) => k === SCRAPE_SEED_COOKIE)?.[1];
  const seed = seedRaw ? decodeURIComponent(seedRaw) : undefined;
  // 关键：seed 已 HMAC 绑定 client IP bucket。换 IP / 跨代理池复用都会被拒绝。
  const seedInfo = verifySeedValue(seed, clientIp);
  if (!seedInfo) {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "请先打开网站页面" }, { status: 403 })
    );
  }

  // 解析 PoW
  let body: { counter?: unknown };
  try {
    body = (await req.json()) as { counter?: unknown };
  } catch {
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
    );
  }
  const counter = typeof body.counter === "string" ? body.counter : "";
  if (!checkPow(seedInfo.nonce, counter)) {
    // 不再 blockIp：网络抖动、页面长时间挂起后重试等真实场景可能导致 PoW 失败，
    // 一次失败就封 24h 过于激进。改为 recordViolation 计数，到阈值再封。
    await recordViolation(clientIp, `gate/issue bad PoW`, req.headers);
    return withAntiScrapeHeaders(
      NextResponse.json(
        { error: "校验失败", difficulty: POW_DIFFICULTY },
        { status: 400 }
      )
    );
  }

  // 二轮渗透加固：seed nonce 一次性。即使攻击者拿到合法 seed + PoW counter，
  // 也无法在 seed 5min TTL 内向不同 IP / 不同会话重复兑换 dr_gate。
  // 没有 Redis 时 markNonceUsed 返回 true（仅靠 IP bucket 绑定兜底）。
  const fresh = await markNonceUsed(seedInfo.nonce);
  if (!fresh) {
    // 不再 blockIp：WiFi↔4G 切网/页面快速刷新等真实场景会触发 nonce 复用，
    // 直接封 IP 会误伤真人。改为 recordViolation 记入计数，到阈值再处理。
    await recordViolation(clientIp, "gate/issue replay nonce", req.headers);
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "请刷新页面重试" }, { status: 403 })
    );
  }

  // 通过：签发 dr_gate（HttpOnly）与提示，同时清除 seed
  const res = withAntiScrapeHeaders(NextResponse.json({ ok: true }));
  setGateCookies(res);
  res.cookies.set(SCRAPE_SEED_COOKIE, "", {
    path: "/",
    maxAge: 0,
  });
  return res;
}

/** GET 用于客户端查询当前 PoW 难度（也可硬编码到 client）。 */
export async function GET() {
  return withAntiScrapeHeaders(
    NextResponse.json({ difficulty: POW_DIFFICULTY })
  );
}
