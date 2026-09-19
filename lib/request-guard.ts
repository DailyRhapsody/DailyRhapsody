import { NextResponse } from "next/server";
import { limitByIp } from "@/lib/upstash-rate-limit";
import { recordViolation } from "@/lib/honeypot";
import { getClientIpFromRequest } from "@/lib/client-ip";
import { getAllowedHostnames } from "@/lib/site-hosts";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

/**
 * 惰性清理过期桶。buckets 以 `${scope}:${ip}` 为 key，只增不删的话，
 * 实例存活期间每个来访 IP 都会留下一条永不回收的记录（serverless 实例可复用数小时）。
 * 不用 setInterval：serverless 上定时器不保证执行，且会阻止实例冻结。
 */
const BUCKET_CLEANUP_INTERVAL_MS = 60_000;
let lastBucketCleanup = Date.now();

function cleanupExpiredBuckets(now: number): void {
  if (now - lastBucketCleanup < BUCKET_CLEANUP_INTERVAL_MS) return;
  lastBucketCleanup = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

const BOT_UA_RE =
  /(bot|spider|crawler|curl|wget|python-requests|scrapy|httpclient|headless|phantom|playwright|puppeteer|go-http-client|axios|got|node-fetch|postman|insomnia|rest-client|java|php|ruby|perl|dotnet|csharp)/i;

/**
 * 合法搜索引擎 + 主流 RSS 客户端 + 分享卡片预览 bot 的 UA 白名单。
 * 这些 UA 关键字本会被 BOT_UA_RE 命中，但都是引流/订阅/分享入口，不应被防爬拦截。
 * 注意：仅靠 UA 字符串可被伪造；高安全场景应配合反向 DNS 校验
 * （Googlebot/Bingbot 官方均提供 verification by reverse DNS）。当前仅用 UA 白名单，
 * 安全衰减由 dr_gate 兜底（即便伪造 UA 拿到 seed，仍要跑 PoW 才能取数据）。
 */
const LEGIT_SEARCH_BOT_RE =
  /(googlebot|bingbot|duckduckbot|yandexbot|baiduspider|sogou|360spider|bytespider|applebot|slurp|petalbot|mojeekbot)/i;

/**
 * RSS 客户端白名单。
 * 注意正则收紧：不能用 `rss\b`/`atom\b` 这种通用子串，否则攻击者把 UA 设成 "myrss/1.0"
 * 就能跳过全局 bot 拦截。这里只列出已知阅读器产品名。
 * 通用「rss/atom」客户端会走 BOT_UA_RE 的 feed 关键字（不在），即仍被拦——可接受。
 */
const LEGIT_RSS_CLIENT_RE =
  /(feedfetcher|feedburner|feedly|inoreader|netnewswire|reeder\/|theoldreader|newsblur|miniflux|ttrss|tt-rss|tiny tiny rss|rssowl|liferea|newsboat|fluent reader|fraidycat|feedbin|feedbro|akregator|quiterss|rsshub)/i;

/**
 * 链接卡片预览 bot 白名单（社交分享展开）。
 * 微信/QQ/豆瓣/即刻/Telegram/Slack/Twitter/Facebook/LinkedIn 等点开链接时会发请求拉 OG/Title。
 * 这些都是引流入口，不能拦。MicroMessenger 是真人微信内置浏览器，但其 LinkSafetyCheck 会
 * 用单独的 UA 提前预扫，也一并放行。
 */
const LEGIT_LINK_PREVIEW_RE =
  /(telegrambot|slackbot|slack-imgproxy|twitterbot|facebookexternalhit|linkedinbot|whatsapp|discordbot|skypeuripreview|line-poker|pinterestbot|redditbot|tumblr|microsoftpreview|microsoft office preview|qqlivebrowser|micromessenger.*linksafetycheck|wechat-link|jikebot|doubanbot)/i;

export function isLegitSearchBot(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? "";
  return LEGIT_SEARCH_BOT_RE.test(ua);
}

export function isLegitRssClient(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? "";
  return LEGIT_RSS_CLIENT_RE.test(ua);
}

export function isLegitLinkPreviewBot(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? "";
  return LEGIT_LINK_PREVIEW_RE.test(ua);
}

const SUSPICIOUS_HEADERS = [
  "x-runtime",
  "x-powered-by",
  "x-generator",
];

/** 用于统计等场景：标记疑似自动化流量（非拦截用） */
export function isLikelyBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? "";
  // 1. 无 User-Agent 的通常是简单爬虫
  if (!ua) return true;
  // 2. 合法搜索引擎 / RSS 客户端 / 分享卡片预览：先于 BOT_UA_RE 排除
  //    （避免 "Googlebot" 命中 "bot" 关键字、"TelegramBot" 命中 "bot" 等）
  if (LEGIT_SEARCH_BOT_RE.test(ua)) return false;
  if (LEGIT_RSS_CLIENT_RE.test(ua)) return false;
  if (LEGIT_LINK_PREVIEW_RE.test(ua)) return false;
  // 3. 匹配常见爬虫关键字
  if (BOT_UA_RE.test(ua)) return true;
  return false;
}

function isSuspiciousRequest(req: Request) {
  const ua = req.headers.get("user-agent");
  if (isLikelyBotUserAgent(ua)) return true;

  // 3. 检查异常请求头
  for (const h of SUSPICIOUS_HEADERS) {
    if (req.headers.has(h)) return true;
  }

  // 4. 检查是否为 headless (一些无头浏览器会设置特定的 Header)
  if (req.headers.has("x-puppeteer-version") || req.headers.has("x-playwright-version")) {
    return true;
  }

  // 5. 现代浏览器通常会发送 Sec-CH-UA
  // 如果 User-Agent 看起来像 Chrome/Edge/Safari 但没有 Sec-CH-UA，可能是伪装的爬虫
  const isChrome = ua?.includes("Chrome") || ua?.includes("Safari");
  if (isChrome && !req.headers.has("sec-ch-ua")) {
    // 允许部分旧浏览器或非主流，但这是一个可疑信号
    // 这里先不做强力拦截，仅作为 suspicious 判定的一部分
    // return true; 
  }

  return false;
}

function urlHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 校验 Origin / Referer 与本站 host 一致，防止跨站抓取与 CSRF 假冒来源。
 * - 必须用精确 hostname 比较（避免 evil-host.com 子串绕过 host.com）。
 * - 至少要有一个（Origin 或 Referer）存在且同源；两者都没有视为可疑。
 * - 白名单只来自 NEXT_PUBLIC_SITE_URL / SITE_HOSTNAMES 环境变量，**不读 Host 头**，
 *   否则攻击者只要 `-H "Host: evil.com" -H "Origin: https://evil.com"` 就能伪造同源。
 */
export function checkOriginOrReferer(req: Request): boolean {
  const allowed = getAllowedHostnames();
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  if (!origin && !referer) return false;

  if (origin) {
    const h = urlHostname(origin);
    if (!h || !allowed.has(h)) return false;
  }
  if (referer) {
    const h = urlHostname(referer);
    if (!h || !allowed.has(h)) return false;
  }
  return true;
}

/**
 * 校验 Sec-Fetch-Site 是否同源。
 * 现代浏览器（Chrome 76+、Firefox 90+、Safari 16+）发起 fetch/XHR/sendBeacon
 * 时会自动带这个头：
 *   - same-origin：站内 fetch（正常情况）
 *   - same-site / cross-site / none：跨站或直接导航
 * 服务器侧 fetch / curl / requests 默认不会发送，所以缺失即视作可疑。
 *
 * 该校验仅对 API 调用生效；页面导航 (Sec-Fetch-Dest=document) 走的是 attachSeed
 * 路径，不经过这里。
 */
export function checkSecFetchSiteSameOrigin(req: Request): boolean {
  const sfs = req.headers.get("sec-fetch-site");
  if (!sfs) return false;
  return sfs === "same-origin";
}

export function withAntiScrapeHeaders(res: NextResponse) {
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

function tooManyRequests(resetAt: number) {
  const now = Date.now();
  return withAntiScrapeHeaders(
    NextResponse.json(
      { error: "请求过于频繁，请稍后再试" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(Math.max(1, resetAt - now) / 1000)),
        },
      }
    )
  );
}

export async function guardApiRequest(
  req: Request,
  {
    scope,
    limit,
    windowMs,
    blockSuspicious = true,
    checkOrigin = true,
    checkSecFetch = true,
    recordRateLimitViolation = true,
  }: {
    scope: string;
    limit: number;
    windowMs: number;
    blockSuspicious?: boolean;
    checkOrigin?: boolean;
    /** 是否要求 Sec-Fetch-Site=same-origin。默认开启；analytics/sendBeacon 等需要时可关闭。 */
    checkSecFetch?: boolean;
    /** 超频是否记违规。数字人对话这类读者会反复点「发送」的接口关掉，免得正常读者被累计封 IP。 */
    recordRateLimitViolation?: boolean;
  }
): Promise<NextResponse | null> {
  const ip = getClientIpFromRequest(req);

  if (blockSuspicious && isSuspiciousRequest(req)) {
    await recordViolation(ip, `suspicious req scope=${scope}`);
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "请求由于可疑行为被拦截" }, { status: 403 })
    );
  }

  if (checkOrigin && !checkOriginOrReferer(req)) {
    await recordViolation(ip, `bad origin scope=${scope}`);
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "禁止跨域抓取" }, { status: 403 })
    );
  }

  if (checkSecFetch && !checkSecFetchSiteSameOrigin(req)) {
    await recordViolation(ip, `bad sec-fetch scope=${scope}`);
    return withAntiScrapeHeaders(
      NextResponse.json({ error: "请求来源异常" }, { status: 403 })
    );
  }

  // Duration 是 `${number} ms` 这种模板字面量类型；windowMs 是普通 number，
  // 拼出来的 string 必须显式断言一下才能塞回去
  const allowed = await limitByIp(scope, ip, limit, `${windowMs} ms` as `${number} ms`);
  if (!allowed) {
    if (recordRateLimitViolation) await recordViolation(ip, `rate limit scope=${scope}`);
    return tooManyRequests(Date.now() + 60_000);
  }

  const now = Date.now();
  cleanupExpiredBuckets(now);
  const key = `${scope}:${ip}`;
  const current = buckets.get(key);
  const bucket =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;

  bucket.count += 1;
  buckets.set(key, bucket);

  if (bucket.count > limit) {
    if (recordRateLimitViolation) await recordViolation(ip, `local bucket scope=${scope}`);
    return tooManyRequests(bucket.resetAt);
  }

  return null;
}
