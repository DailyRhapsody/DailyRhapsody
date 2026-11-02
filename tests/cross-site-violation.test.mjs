// node --experimental-test-module-mocks --test tests/cross-site-violation.test.mjs
//
// 第三方页面诱导的跨站请求：照常拒绝，但不计违规、不封 IP。
//
// 旧实现里，一个第三方页面放一张 <img src="https://tengjun.org/api/honeypot"> 就能把访客的出口
// 封 24 小时；对受保护接口连放 4 张图也能凑满违规阈值。浏览器带着访客的真实 UA，SameSite=Lax
// 的 cookie 又不随跨站子资源发送，站长豁免与门闸都认不出这是真人。
//
// 这里只替换两个边界：@upstash/redis（内存实现）与 @upstash/ratelimit（恒放行），
// proxy、蜜罐路由、guardApiRequest、违规计数与封禁都走真实实现。
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
      // 访客侧请求不带站长 cookie：第三方页面的子资源请求本来就带不上 SameSite=Lax 的 cookie
      return {
        format: "module",
        shortCircuit: true,
        source: "export async function cookies() { return { get() { return undefined; } }; }",
      };
    }
    return next(url, context);
  },
});

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_15 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15";

/** 第三方页面里的 <img src="https://tengjun.org/…">，现代浏览器发出的请求头 */
const crossSiteImage = (ip) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-dest": "image",
  referer: "https://evil.example/",
});
/** 同一张图在不发 Fetch Metadata 的旧 Safari 里，且攻击者给 <img> 加了 referrerpolicy=no-referrer */
const legacyImage = (ip) => ({
  "cf-connecting-ip": ip,
  "user-agent": SAFARI_15,
  accept: "image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
});
/** 伪装浏览器 UA、但不带任何 Fetch Metadata 的脚本 */
const scripted = (ip) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: "application/json",
});
/** 无头浏览器顺着本站页面里的隐藏链接点进蜜罐 */
const sameOriginNavigation = (ip) => ({
  "cf-connecting-ip": ip,
  "user-agent": CHROME,
  accept: "text/html,application/xhtml+xml",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  referer: "https://tengjun.org/blog",
});

test("isCrossSiteInduced：只认浏览器明确表明来自别的站", async (t) => {
  const { isCrossSiteInduced } = await import("../lib/fetch-metadata.ts");
  const cases = [
    ["现代浏览器的跨站子资源", { "sec-fetch-site": "cross-site" }, true],
    ["同站的其它子域", { "sec-fetch-site": "same-site" }, true],
    ["本站页面发出", { "sec-fetch-site": "same-origin", referer: "https://tengjun.org/blog" }, false],
    ["地址栏直接访问 / 脚本 page.goto", { "sec-fetch-site": "none" }, false],
    ["声明 same-origin 时不再看 Referer", { "sec-fetch-site": "same-origin", referer: "https://evil.example/" }, false],
    ["curl 默认请求头", { "user-agent": "curl/8.5.0", accept: "*/*" }, false],
    ["python-requests 默认请求头", { "user-agent": "python-requests/2.32.3", accept: "*/*" }, false],
    ["旧浏览器的 <img>（无 Fetch Metadata、无 Referer）", { accept: "image/webp,image/*;q=0.8" }, true],
    ["旧浏览器的跨站跳转（Referer 指外站）", { accept: "text/html", referer: "https://evil.example/post" }, true],
    ["旧浏览器的跨站表单（Origin 指外站）", { origin: "https://evil.example" }, true],
    ["不透明来源 Origin: null", { origin: "null" }, true],
    ["本站 www 子域的 Referer", { referer: "https://www.tengjun.org/blog" }, false],
    ["主机名前缀伪装的外站", { referer: "https://tengjun.org.evil.example/" }, true],
    ["畸形 Referer 不算证据", { referer: "::not a url::" }, false],
  ];
  for (const [name, headers, expected] of cases) {
    await t.test(name, () => {
      assert.equal(isCrossSiteInduced(new Headers(headers)), expected);
    });
  }
});

test("跨站诱导只拒绝、不计违规；本站页面内的自动化与脚本照旧计数封禁", async (t) => {
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
  t.mock.module("@upstash/ratelimit", {
    namedExports: {
      Ratelimit: class {
        static slidingWindow() {
          return {};
        }
        async limit() {
          return { success: true };
        }
      },
    },
  });

  const blocked = () => {
    throw new Error("Real network is forbidden in this test");
  };
  const fetchMock = t.mock.method(globalThis, "fetch", blocked);
  const connectMock = t.mock.method(Socket.prototype, "connect", blocked);
  t.after(() => {
    hooks.deregister();
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
  });

  const { NextRequest } = await import("next/server");
  const { default: proxy } = await import("../proxy.ts");
  const { GET: honeypot } = await import("../app/api/honeypot/route.ts");
  const { guardApiRequest } = await import("../lib/request-guard.ts");

  const viaProxy = (path, headers) => proxy(new NextRequest(`https://tengjun.org${path}`, { headers }));
  const isBlocked = (ip) => store.has(`dr:blocked:${ip}`);
  const violations = (ip) => Number(store.get(`dr:viol:${ip}`)) || 0;

  await t.test("第三方页面连放 6 张图打受保护接口：每次 403，不计违规、不封", async () => {
    const ip = "198.51.100.1";
    for (let i = 0; i < 6; i++) {
      const res = await viaProxy("/api/diaries", crossSiteImage(ip));
      assert.equal(res.status, 403);
    }
    assert.equal(violations(ip), 0);
    assert.equal(isBlocked(ip), false);
  });

  await t.test("旧 Safari 里的同一招（无 Fetch Metadata、无 Referer）同样不计", async () => {
    const ip = "198.51.100.2";
    for (let i = 0; i < 6; i++) {
      const res = await viaProxy("/api/diaries", legacyImage(ip));
      assert.equal(res.status, 403);
    }
    assert.equal(isBlocked(ip), false);
  });

  await t.test("对照：不带 gate 也不带 Fetch Metadata 的脚本，4 次即封", async () => {
    const ip = "198.51.100.3";
    for (let i = 0; i < 4; i++) await viaProxy("/api/diaries", scripted(ip));
    assert.equal(isBlocked(ip), true);
  });

  await t.test("第三方页面里的蜜罐图片：403，不封访客", async () => {
    const ip = "198.51.100.4";
    const res = await honeypot(
      new Request("https://tengjun.org/api/honeypot", { headers: crossSiteImage(ip) })
    );
    assert.equal(res.status, 403);
    assert.equal(isBlocked(ip), false);
  });

  await t.test("顺着本站隐藏链接点进蜜罐的无头浏览器：照旧即封", async () => {
    const ip = "198.51.100.5";
    await honeypot(new Request("https://tengjun.org/api/honeypot", { headers: sameOriginNavigation(ip) }));
    assert.equal(isBlocked(ip), true);
  });

  await t.test("不带 Fetch Metadata 的脚本访问蜜罐：照旧即封", async () => {
    const ip = "198.51.100.6";
    await honeypot(new Request("https://tengjun.org/api/honeypot", { headers: scripted(ip) }));
    assert.equal(isBlocked(ip), true);
  });

  await t.test("跨站表单反复提交写接口：403，不计违规", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < 6; i++) {
      const res = await guardApiRequest(
        new Request("https://tengjun.org/api/diaries/x/comments", {
          method: "POST",
          headers: {
            "cf-connecting-ip": ip,
            "user-agent": CHROME,
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
          },
        }),
        { scope: "test:write", limit: 100, windowMs: 60_000 }
      );
      assert.equal(res?.status, 403);
    }
    assert.equal(violations(ip), 0);
    assert.equal(isBlocked(ip), false);
  });

  await t.test("对照：缺 Origin 与 Referer 的脚本写请求照旧计违规", async () => {
    const ip = "198.51.100.8";
    for (let i = 0; i < 4; i++) {
      await guardApiRequest(
        new Request("https://tengjun.org/api/diaries/x/comments", {
          method: "POST",
          headers: scripted(ip),
        }),
        { scope: "test:write", limit: 100, windowMs: 60_000 }
      );
    }
    assert.equal(isBlocked(ip), true);
  });
});
