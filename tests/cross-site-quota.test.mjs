// node --experimental-test-module-mocks --test tests/cross-site-quota.test.mjs
//
// #198 残留：跨站诱导的请求只是不计违规，却仍在扣访客出口 IP 的全局限流额度。
// 第三方页面让访客的浏览器发一批跨站请求把 global:burst / global:sustained 用满，
// 访客随后在本站的正常访问就会 429、被记违规，4 次即封 24 小时。
//
// 只替身三个边界：@upstash/redis（内存实现）、@upstash/ratelimit（按 2.0.8 的滑动窗口语义
// 计数、被拒的请求不记账，时钟由测试控制）、网络（禁止真实连接）。proxy、违规计数、封禁、
// 门闸校验都走真实实现。断言只看访客能感知的结果：状态码、违规计数、是否被封。
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
    if (specifier === "next/headers") {
      return { url: "mock:next-headers", shortCircuit: true, format: "module" };
    }
    return next(
      specifier.startsWith("@/")
        ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href
        : specifier,
      context
    );
  },
  load(url, context, next) {
    if (url === "mock:next-headers") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export async function cookies() { return { get() { return undefined; } }; }",
      };
    }
    return next(url, context);
  },
});

const SITE = "https://tengjun.org";
const EVIL = "https://evil.example/";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_15 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const withGate = (gate) => (gate ? { cookie: `dr_gate=${gate}` } : {});

/** 第三方页面里的 <img src="https://tengjun.org/api/diaries?n=…">（Chrome）。SameSite=Lax 的 cookie 不随跨站子资源发送。 */
const xsImage = (ip) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-dest": "image",
  referer: EVIL,
});
/** 同一张图在不发 Fetch Metadata 的旧 Safari 里，<img referrerpolicy="no-referrer"> */
const legacyImage = (ip) => ({
  "cf-connecting-ip": ip,
  "user-agent": SAFARI_15,
  accept: "image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
});
/**
 * 第三方页面用脚本反复导航它打开的弹窗（w.location = "https://tengjun.org/blog?…"）：
 * 顶层导航、无用户激活，所以没有 Sec-Fetch-User；SameSite=Lax 的 cookie 随顶层 GET 导航发送。
 */
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
/** 访客在别的网站点了一条指向本站的链接 */
const xsLinkClick = (ip, gate) => ({ ...xsPopupNavigation(ip, gate), "sec-fetch-user": "?1" });
/** 访客在本站内点链接（Chrome） */
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
/** 本站页面里的接口请求（Chrome） */
const ownApi = (ip, gate) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: "*/*",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  referer: `${SITE}/blog`,
  ...withGate(gate),
});
/** 旧 Safari 里的同样两类请求：没有 Fetch Metadata，Referer 指向本站 */
const ownNavigationLegacy = (ip, gate) => ({
  "cf-connecting-ip": ip,
  "user-agent": SAFARI_15,
  accept: HTML_ACCEPT,
  referer: `${SITE}/`,
  ...withGate(gate),
});
const ownApiLegacy = (ip, gate) => ({
  "cf-connecting-ip": ip,
  "user-agent": SAFARI_15,
  accept: "*/*",
  referer: `${SITE}/blog`,
  ...withGate(gate),
});
/** 伪装浏览器 UA、不带 Fetch Metadata 的脚本 */
const scripted = (ip) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: "application/json",
});

test("跨站请求不得占用访客自己的全局限流额度", async (t) => {
  // ---- @upstash/redis：违规计数与封禁用到的几个命令 ----
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
          const next = (Number(store.get(key)) || 0) + 1;
          store.set(key, next);
          return next;
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

  // ---- @upstash/ratelimit：滑动窗口，照 2.0.8 RegionRatelimit 的 slidingWindowLimitScript ----
  // floor((1-p)*prev) + cur >= tokens 即拒；被拒的请求不记账。时钟由测试推进。
  const clock = { now: Date.UTC(2026, 10, 3, 8, 0, 0) }; // 整分钟，窗口边界对齐
  const UNIT = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const toMs = (d) => {
    const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(String(d).trim());
    if (!m) throw new Error(`unsupported duration ${d}`);
    return Number(m[1]) * UNIT[m[2]];
  };
  const windows = new Map();
  /** 每次限流调用的 (prefix, identifier)，对应 Redis 键 `<prefix>:<identifier>:<窗口号>` */
  const limitCalls = [];
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
          limitCalls.push({ prefix: this.prefix, identifier });
          const { tokens, windowMs } = this.limiter;
          const idx = Math.floor(clock.now / windowMs);
          const curKey = `${this.prefix}:${identifier}:${idx}`;
          const cur = windows.get(curKey) ?? 0;
          const prev = windows.get(`${this.prefix}:${identifier}:${idx - 1}`) ?? 0;
          const p = (clock.now % windowMs) / windowMs;
          const reset = (idx + 1) * windowMs;
          if (Math.floor((1 - p) * prev) + cur >= tokens) {
            return { success: false, limit: tokens, remaining: 0, reset, pending: Promise.resolve() };
          }
          windows.set(curKey, cur + 1);
          return { success: true, limit: tokens, remaining: tokens - cur - 1, reset, pending: Promise.resolve() };
        }
      },
    },
  });

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

  const send = async (path, headers) =>
    (await proxy(new NextRequest(`${SITE}${path}`, { headers }))).status;
  const isBlocked = (ip) => store.has(`dr:blocked:${ip}`);
  const violations = (ip) => Number(store.get(`dr:viol:${ip}`)) || 0;
  const at = (ms) => {
    clock.now = start + ms;
  };
  let start = clock.now;
  /** 每个用例换一个整分钟起点，互不影响 */
  const freshMinute = () => {
    start = clock.now = (Math.floor(clock.now / 60_000) + 10) * 60_000;
  };

  /** 访客自己正常访问一次 /blog：一次站内导航 + 首屏 3 个接口（已握手，带有效 dr_gate） */
  const ownVisit = async (ip, gate, nav = ownNavigation, api = ownApi) => {
    const statuses = [
      await send("/blog", nav(ip, gate)),
      await send("/api/profile", api(ip, gate)),
      await send("/api/diaries?page=1", api(ip, gate)),
      await send("/api/diaries/comment-counts", api(ip, gate)),
    ];
    return { statuses, violations: violations(ip), blocked: isBlocked(ip) };
  };
  const UNHARMED = { statuses: [200, 200, 200, 200], violations: 0, blocked: false };

  await t.test("第三方页面 45 张跨站 <img> 之后，访客自己的访问不被限流、不计违规、不被封", async () => {
    freshMinute();
    const ip = "198.51.100.11";
    const gate = mintGateValue();
    at(1_000);
    for (let i = 0; i < 45; i++) await send(`/api/diaries?n=${i}`, xsImage(ip));
    at(2_000);
    assert.deepEqual(await ownVisit(ip, gate), UNHARMED);
  });

  await t.test("跨站 <img> 改指页面路径（/blog?n=…）同样碰不到访客的额度", async () => {
    freshMinute();
    const ip = "198.51.100.15";
    const gate = mintGateValue();
    at(1_000);
    for (let i = 0; i < 45; i++) await send(`/blog?n=${i}`, xsImage(ip));
    at(2_000);
    assert.deepEqual(await ownVisit(ip, gate), UNHARMED);
  });

  await t.test("旧 Safari（无 Fetch Metadata）里的同一招同样碰不到访客的额度", async () => {
    freshMinute();
    const ip = "198.51.100.12";
    const gate = mintGateValue();
    at(1_000);
    for (let i = 0; i < 45; i++) await send(`/api/diaries?n=${i}`, legacyImage(ip));
    at(2_000);
    assert.deepEqual(await ownVisit(ip, gate, ownNavigationLegacy, ownApiLegacy), UNHARMED);
  });

  await t.test("每秒 3 张图、50 秒用满 150/分钟的 sustained 额度（不触发 burst），访客同样不受影响", async () => {
    freshMinute();
    const ip = "198.51.100.13";
    const gate = mintGateValue();
    for (let i = 0; i < 150; i++) {
      at(i * 334);
      await send(`/api/diaries?n=${i}`, xsImage(ip));
    }
    at(55_000);
    assert.deepEqual(await ownVisit(ip, gate), UNHARMED);
  });

  await t.test("第三方页面用脚本把它打开的弹窗连续导航 45 次（跨站顶层导航），这些导航请求本身不占访客的额度", async () => {
    freshMinute();
    const ip = "198.51.100.14";
    const gate = mintGateValue();
    at(1_000);
    for (let i = 0; i < 45; i++) await send(`/blog?n=${i}`, xsPopupNavigation(ip, gate));
    at(2_000);
    assert.deepEqual(await ownVisit(ip, gate), UNHARMED);
  });

  // ---- 防过度修复的对照：以下在修复前后都必须成立 ----

  await t.test("对照：他站链接点进来的顶层导航照常放行并签发 dr_seed", async () => {
    freshMinute();
    const ip = "198.51.100.21";
    at(1_000);
    const res = await proxy(new NextRequest(`${SITE}/blog`, { headers: xsLinkClick(ip) }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") ?? "", /dr_seed=/);
  });

  await t.test("对照：跨站请求自身仍受限流（10 秒内第 41 次起 429），只是不计违规、不封", async () => {
    freshMinute();
    const ip = "198.51.100.22";
    at(1_000);
    const statuses = [];
    for (let i = 0; i < 45; i++) statuses.push(await send(`/blog?n=${i}`, xsPopupNavigation(ip)));
    assert.deepEqual(
      { ok: statuses.filter((s) => s === 200).length, limited: statuses.filter((s) => s === 429).length },
      { ok: 40, limited: 5 }
    );
    assert.equal(violations(ip), 0);
    assert.equal(isBlocked(ip), false);
  });

  await t.test("对照：跨站请求同样受 sustained 约束（60 秒内 160 次、不触发 burst，第 151 次起 429），只是不计违规、不封", async () => {
    freshMinute();
    const ip = "198.51.100.24";
    const statuses = [];
    for (let i = 0; i < 160; i++) {
      at(i * 370);
      statuses.push(await send(`/blog?n=${i}`, xsPopupNavigation(ip)));
    }
    assert.deepEqual(
      { ok: statuses.filter((s) => s === 200).length, limited: statuses.filter((s) => s === 429).length },
      { ok: 150, limited: 10 }
    );
    assert.equal(violations(ip), 0);
    assert.equal(isBlocked(ip), false);
  });

  await t.test("对照：跨站额度按 IP 计，IP A 的跨站额度被 45 张跨站图用满后，IP B 从他站链接点进来照常 200、不计违规", async () => {
    freshMinute();
    const a = "198.51.100.25";
    const b = "198.51.100.26";
    at(1_000);
    for (let i = 0; i < 45; i++) await send(`/api/diaries?n=${i}`, xsImage(a));
    at(2_000);
    assert.equal(await send("/blog", xsLinkClick(a)), 429); // 前提：A 的跨站额度确已用满
    assert.equal(await send("/blog", xsLinkClick(b)), 200);
    assert.equal(violations(b), 0);
  });

  await t.test("对照：同源请求仍记在原来的两个限流键上（上线不重置访客已用的额度）", async () => {
    freshMinute();
    const ip = "198.51.100.27";
    at(1_000);
    limitCalls.length = 0;
    assert.equal(await send("/api/diaries?page=1", ownApi(ip, mintGateValue())), 200);
    assert.deepEqual(limitCalls, [
      { prefix: "dr:rl:global:burst", identifier: ip },
      { prefix: "dr:rl:global:sustained", identifier: ip },
    ]);
  });

  await t.test("对照：不带 Fetch Metadata 的脚本超额照旧计违规，4 次即封", async () => {
    freshMinute();
    const ip = "198.51.100.23";
    at(1_000);
    for (let i = 0; i < 44; i++) await send(`/blog?n=${i}`, scripted(ip));
    assert.equal(isBlocked(ip), true);
  });
});
