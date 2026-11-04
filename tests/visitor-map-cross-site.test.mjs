// node --experimental-test-module-mocks --test tests/visitor-map-cross-site.test.mjs
//
// /api/analytics/visitor-map 的路由层限流（guardApiRequest，scope=analytics:visitormap，60 次/分钟，
// 超额计违规）只按 IP 计。第三方页面反复改写它打开的弹窗地址，能让访客的浏览器跨站顶层导航到这个接口
// （SameSite=Lax 的 dr_gate 随顶层 GET 导航带上，proxy 放行）。路由若不校验 Sec-Fetch-Site，这些导航就会
// 用光访客的路由额度，访客随后在 /blog 的正常取数被 429 并计违规，4 次即封。该接口只给 /blog 的同源
// fetch 用，不提供跨站调用：跨站导航应在限流之前被拒（403，跨站不计违规）。
//
// 走真实实现：proxy.ts、visitor-map 路由、guardApiRequest、违规计数与封禁、门闸签名。
// 只替身边界：@upstash/redis（内存）、@upstash/ratelimit（单区域滑动窗口公式，时钟可控）、
// next/headers 的 cookies()（按本次请求的 Cookie 头返回）、@/lib/analytics-store（数据层，返回固定点位）、网络。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "test-secret-at-least-16-chars";
process.env.NEXT_PUBLIC_SITE_URL = "https://tengjun.org";
process.env.IP_TRUSTED_PROXY = "cloudflare";
process.env.UPSTASH_REDIS_REST_URL = "https://redis.test.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/server") return next("next/server.js", context);
    if (specifier === "next/headers") return { url: "mock:next-headers", shortCircuit: true, format: "module" };
    if (specifier === "@/lib/analytics-store") return { url: "mock:analytics-store", shortCircuit: true, format: "module" };
    return next(
      specifier.startsWith("@/") ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier,
      context
    );
  },
  load(url, context, next) {
    if (url === "mock:next-headers") {
      return {
        format: "module",
        shortCircuit: true,
        source: `export async function cookies() {
  const jar = globalThis.__VISITOR_MAP_COOKIES__ || {};
  return { get: (name) => (name in jar ? { name, value: jar[name] } : undefined) };
}`,
      };
    }
    if (url === "mock:analytics-store") {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const VISITOR_MAP_WINDOW_DAYS = 30;
export async function getVisitorMapPayload() {
  return { points: [{ lat: 40.092, lon: 115.851, count: 3 }], generatedAt: "2026-11-04T00:00:00.000Z", windowDays: 30 };
}`,
      };
    }
    return next(url, context);
  },
});

const SITE = "https://tengjun.org";
const EVIL = "https://evil.example/";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const withGate = (gate) => (gate ? { cookie: `dr_gate=${gate}` } : {});

/** 第三方页面改写弹窗地址：跨站顶层导航，无用户激活（无 Sec-Fetch-User），Lax cookie 随行 */
const xsPopupNavigation = (ip, gate) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: HTML_ACCEPT,
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "upgrade-insecure-requests": "1",
  referer: EVIL,
  ...withGate(gate),
});
/** 访客在本站内导航到 /blog */
const ownNavigation = (ip, gate) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: HTML_ACCEPT,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-user": "?1",
  referer: `${SITE}/`,
  ...withGate(gate),
});
/** /blog 页面里的 fetch("/api/analytics/visitor-map")：同源 GET 不带 Origin，Referer 为完整页面地址 */
const ownMapFetch = (ip, gate) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: "*/*",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  referer: `${SITE}/blog`,
  ...withGate(gate),
});

const parseCookie = (raw = "") =>
  Object.fromEntries(
    raw
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])
  );

test("跨站顶层导航不得占用访客在 visitor-map 路由上的限流额度", async (t) => {
  const store = new Map();
  t.mock.module("@upstash/redis", {
    namedExports: {
      Redis: class {
        async get(key) {
          return store.has(key) ? structuredClone(store.get(key)) : null;
        }
        async set(key, value, options) {
          if (options?.nx && store.has(key)) return null;
          store.set(key, structuredClone(value));
          return "OK";
        }
        async incr(key) {
          const n = (Number(store.get(key)) || 0) + 1;
          store.set(key, n);
          return n;
        }
        async expire() {
          return 1;
        }
        async ttl() {
          return 86_400;
        }
        async del(...keys) {
          let removed = 0;
          for (const key of keys) if (store.delete(key)) removed++;
          return removed;
        }
      },
    },
  });

  const clock = { now: Date.UTC(2026, 10, 4, 9, 0, 0) };
  const UNIT = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const toMs = (d) => {
    const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(String(d).trim());
    if (!m) throw new Error(`unsupported duration ${d}`);
    return Number(m[1]) * UNIT[m[2]];
  };
  const windows = new Map();
  t.mock.module("@upstash/ratelimit", {
    namedExports: {
      Ratelimit: class {
        static slidingWindow(tokens, window) {
          return { tokens, windowMs: toMs(window) };
        }
        constructor({ limiter, prefix }) {
          this.limiter = limiter;
          this.prefix = prefix;
        }
        async limit(identifier) {
          const { tokens, windowMs } = this.limiter;
          const idx = Math.floor(clock.now / windowMs);
          const base = `${this.prefix}:${identifier}`;
          const cur = windows.get(`${base}:${idx}`) ?? 0;
          const prev = windows.get(`${base}:${idx - 1}`) ?? 0;
          const p = (clock.now % windowMs) / windowMs;
          const reset = (idx + 1) * windowMs;
          // @upstash/ratelimit 2.0.8 单区域 slidingWindowLimitScript：floor((1-p)*prev) + cur >= limit 即拒，拒绝不记账
          if (Math.floor((1 - p) * prev) + cur >= tokens) {
            return { success: false, limit: tokens, remaining: 0, reset, pending: Promise.resolve() };
          }
          windows.set(`${base}:${idx}`, cur + 1);
          return { success: true, limit: tokens, remaining: tokens - cur - 1, reset, pending: Promise.resolve() };
        }
      },
    },
  });

  // 路由里的进程内兜底桶用 Date.now()：同一时钟
  t.mock.method(Date, "now", () => clock.now);

  const forbidden = () => {
    throw new Error("Real network is forbidden in this test");
  };
  const fetchMock = t.mock.method(globalThis, "fetch", forbidden);
  const connectMock = t.mock.method(Socket.prototype, "connect", forbidden);
  t.after(() => {
    hooks.deregister();
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
  });

  const { NextRequest } = await import("next/server");
  const { default: proxy } = await import("../proxy.ts");
  const { mintGateValue } = await import("../lib/scrape-gate.ts");
  const { GET: visitorMap } = await import("../app/api/analytics/visitor-map/route.ts");

  /** 先过 proxy；proxy 放行（NextResponse.next）时，接口交给真实路由，页面按已渲染计 200 */
  const send = async (path, headers) => {
    const res = await proxy(new NextRequest(`${SITE}${path}`, { headers }));
    if (res.headers.get("x-middleware-next") !== "1") return res.status;
    if (!path.startsWith("/api/analytics/visitor-map")) return 200;
    globalThis.__VISITOR_MAP_COOKIES__ = parseCookie(headers.cookie);
    return (await visitorMap(new Request(`${SITE}${path}`, { headers }))).status;
  };
  const isBlocked = (ip) => store.has(`dr:blocked:${ip}`);
  const violations = (ip) => Number(store.get(`dr:viol:${ip}`)) || 0;
  let start = clock.now;
  const at = (ms) => {
    clock.now = start + ms;
  };
  const freshMinute = () => {
    start = clock.now = (Math.floor(clock.now / 60_000) + 10) * 60_000;
  };
  const tally = (statuses) => statuses.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});

  await t.test("第三方弹窗 60 次跨站导航到 visitor-map（一律 403）之后，访客 4 次打开 /blog 取地图：200、不计违规、不被封", async () => {
    freshMinute();
    const ip = "198.51.100.51";
    const gate = mintGateValue();
    const attack = [];
    for (let i = 0; i < 60; i++) {
      at(i * 334);
      attack.push(await send("/api/analytics/visitor-map", xsPopupNavigation(ip, gate)));
    }
    t.diagnostic(`attack statuses=${JSON.stringify(tally(attack))} viol=${violations(ip)}`);
    assert.equal(violations(ip), 0, "跨站请求本身不计违规（#198 已有行为）");

    const own = [];
    for (let k = 0; k < 4; k++) {
      at(21_000 + k * 5_000);
      own.push(await send("/blog", ownNavigation(ip, gate)));
      at(22_300 + k * 5_000);
      own.push(await send("/api/analytics/visitor-map", ownMapFetch(ip, gate)));
    }
    assert.deepEqual(
      { own, violations: violations(ip), blocked: isBlocked(ip) },
      { own: [200, 200, 200, 200, 200, 200, 200, 200], violations: 0, blocked: false }
    );
    assert.deepEqual(tally(attack), { 403: 60 }, "该接口不提供跨站调用：跨站导航在限流之前回 403，拿不到点位");
  });

  await t.test("对照：访客自己 1 分钟内第 61 次取地图照旧 429 并计违规（路由限流不能被修掉）", async () => {
    freshMinute();
    const ip = "198.51.100.52";
    const gate = mintGateValue();
    const statuses = [];
    for (let i = 0; i < 61; i++) {
      at(i * 900);
      statuses.push(await send("/api/analytics/visitor-map", ownMapFetch(ip, gate)));
    }
    assert.deepEqual(tally(statuses), { 200: 60, 429: 1 });
    assert.equal(violations(ip), 1);
  });
});
