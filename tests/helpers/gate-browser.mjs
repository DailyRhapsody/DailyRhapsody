// 门闸测试共用替身（tests/gate-*.test.mjs）：进程内的「浏览器标签页」+ 真实 proxy / 门闸路由。
//
// 只替换系统边界：
//  - @upstash/redis：内存实现。@upstash/ratelimit 用真实库，替身 Redis 按 Upstash 的 Lua 脚本语义
//    执行滑动窗口（evalsha 回 NOSCRIPT，库自动改走 eval），所以限流判定与生产同一套代码。
//  - next/headers、时钟（node:test mock timers）、浏览器全局（window / document.cookie /
//    sessionStorage / fetch / crypto.subtle.digest）。
// proxy.ts、app/api/gate/{issue,seed}、lib/honeypot、lib/scrape-gate、lib/fetch-with-timeout、
// lib/gate-handshake、components/GateClient.tsx 都是真实模块（.tsx 用仓库自带的 typescript 转译，不改语义）。
//
// 页面刷新 = 新的 JS 运行环境：客户端模块按 ?page=N 重新实例化（模块级状态清零），window 换新
// （旧监听器随之消失），sessionStorage 与 cookie 罐跨刷新保留（与浏览器同一标签页一致）。
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

export const ORIGIN = "https://tengjun.org";
export const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const HOUR = 3_600_000;

const ROOT = new URL("../../", import.meta.url);
const require = createRequire(import.meta.url);

export function setupEnv() {
  globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
  process.env.NODE_ENV = "test";
  process.env.AUTH_SECRET = "test-secret-at-least-16-chars";
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  process.env.IP_TRUSTED_PROXY = "cloudflare";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";
}

function resolveAlias(specifier) {
  const base = new URL(specifier.slice(2), ROOT);
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    const u = new URL(base.href + ext);
    if (existsSync(fileURLToPath(u))) return u.href;
  }
  return base.href + ".ts";
}

let ts = null;
export function registerProjectHooks() {
  return registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "next/server") return next("next/server.js", context);
      if (specifier === "next/headers") return { url: "mock:next-headers", shortCircuit: true, format: "module" };
      const page = context.parentURL?.startsWith("file:")
        ? new URL(context.parentURL).searchParams.get("page")
        : null;
      // 客户端组件里的 React 只用到 useEffect：挂载即执行（等价于浏览器里的首次提交）
      if (specifier === "react" && page) return { url: "mock:react", shortCircuit: true, format: "module" };
      const r = specifier.startsWith("@/")
        ? { url: resolveAlias(specifier), shortCircuit: true }
        : next(specifier, context);
      if (page && r.url.startsWith(ROOT.href) && !r.url.includes("/node_modules/")) {
        const u = new URL(r.url);
        u.searchParams.set("page", page);
        return { ...r, url: u.href, shortCircuit: true };
      }
      return r;
    },
    load(url, context, next) {
      if (url === "mock:next-headers") {
        return {
          format: "module",
          shortCircuit: true,
          source: "export async function cookies() { return { get() { return undefined; } }; }",
        };
      }
      if (url === "mock:react") {
        return {
          format: "module",
          shortCircuit: true,
          source: "export function useEffect(fn) { fn(); }\nexport default { useEffect };",
        };
      }
      if (url.startsWith("file:") && new URL(url).pathname.endsWith(".tsx")) {
        ts ??= require("typescript");
        const file = fileURLToPath(url);
        const out = ts.transpileModule(readFileSync(file, "utf8"), {
          fileName: file,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.ReactJSX,
          },
        });
        return { format: "module", shortCircuit: true, source: out.outputText };
      }
      return next(url, context);
    },
  });
}

/* ───────── Redis 替身（含 @upstash/ratelimit 用到的 Lua 脚本语义）───────── */

export function createRedisStore() {
  const data = new Map(); // key -> { value, expiresAt }
  const violations = new Map(); // ip -> 累计违规次数
  const live = (key) => {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== Infinity && e.expiresAt <= Date.now()) {
      data.delete(key);
      return undefined;
    }
    return e;
  };
  const getRaw = (key) => live(key)?.value;
  const setRaw = (key, value, ttlMs) =>
    data.set(key, { value, expiresAt: ttlMs == null ? Infinity : Date.now() + ttlMs });
  const incrBy = (key, n) => {
    const e = live(key);
    const value = (Number(e?.value) || 0) + n;
    data.set(key, { value, expiresAt: e ? e.expiresAt : Infinity });
    return value;
  };
  const pexpire = (key, ms) => {
    const e = live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + ms;
    return 1;
  };

  // @upstash/ratelimit 2.x 单区域 slidingWindow.limit 脚本（node_modules/@upstash/ratelimit/dist/index.js）
  // 的逐行等价实现：前一窗口按剩余比例折算后向下取整；拒绝的请求不计数。
  function slidingWindowLimit(keys, args) {
    const [currentKey, previousKey, dynamicLimitKey] = keys;
    const tokens = Number(args[0]);
    const now = Number(args[1]);
    const window = Number(args[2]);
    const incrementBy = Number(args[3]);
    let effectiveLimit = tokens;
    if (dynamicLimitKey) {
      const d = getRaw(dynamicLimitKey);
      if (d != null) effectiveLimit = Number(d);
    }
    const current = Number(getRaw(currentKey) ?? 0);
    const previousRaw = Number(getRaw(previousKey) ?? 0);
    const percentageInCurrent = (now % window) / window;
    const previous = Math.floor((1 - percentageInCurrent) * previousRaw);
    if (incrementBy > 0 && previous + current >= effectiveLimit) return [-1, effectiveLimit];
    const newValue = incrBy(currentKey, incrementBy);
    if (newValue === incrementBy) pexpire(currentKey, window * 2 + 1000);
    return [effectiveLimit - (newValue + previous), effectiveLimit];
  }

  class Redis {
    async get(key) {
      const v = getRaw(key);
      return v === undefined ? null : structuredClone(v);
    }
    async set(key, value, options) {
      if (options?.nx && live(key)) return null;
      setRaw(key, structuredClone(value), options?.ex != null ? options.ex * 1000 : options?.px ?? null);
      return "OK";
    }
    async incr(key) {
      // 封禁时 honeypot 会删掉 dr:viol:<ip>，这里另记一份累计次数供断言
      if (key.startsWith("dr:viol:")) violations.set(key.slice(8), (violations.get(key.slice(8)) ?? 0) + 1);
      return incrBy(key, 1);
    }
    async expire(key, seconds) {
      return pexpire(key, seconds * 1000);
    }
    async ttl(key) {
      const e = live(key);
      if (!e) return -2;
      if (e.expiresAt === Infinity) return -1;
      return Math.ceil((e.expiresAt - Date.now()) / 1000);
    }
    async del(...keys) {
      let n = 0;
      for (const k of keys.flat()) if (live(k) && data.delete(k)) n++;
      return n;
    }
    async evalsha() {
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    }
    async eval(script, keys, args) {
      if (script.includes("requestsInPreviousWindow") && script.includes("INCRBY")) {
        return slidingWindowLimit(keys, args);
      }
      throw new Error(`b1-gate redis stub: unsupported script ${script.slice(0, 60)}`);
    }
  }
  return {
    Redis,
    data,
    getRaw,
    violTotal: (ip) => violations.get(ip) ?? 0,
    isBlocked: (ip) => getRaw(`dr:blocked:${ip}`) !== undefined,
  };
}

/* ───────── cookie 罐（按 Max-Age 与当前时钟过期；HttpOnly 对脚本不可见）───────── */

export class CookieJar {
  constructor() {
    this.map = new Map();
  }
  purge() {
    for (const [k, c] of this.map) if (c.expiresAt <= Date.now()) this.map.delete(k);
  }
  applySetCookie(lines) {
    for (const line of lines) {
      const [pair, ...attrs] = line.split(/;\s*/);
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      let expiresAt = Infinity;
      let httpOnly = false;
      for (const a of attrs) {
        const [k, v] = a.split("=");
        const key = k.trim().toLowerCase();
        if (key === "max-age") expiresAt = Date.now() + Number(v) * 1000;
        else if (key === "expires" && expiresAt === Infinity) expiresAt = new Date(v).getTime();
        else if (key === "httponly") httpOnly = true;
      }
      if (expiresAt <= Date.now()) this.map.delete(name);
      else this.map.set(name, { value, expiresAt, httpOnly });
    }
  }
  header() {
    this.purge();
    return [...this.map].map(([k, c]) => `${k}=${c.value}`).join("; ");
  }
  forScript() {
    this.purge();
    return [...this.map].filter(([, c]) => !c.httpOnly).map(([k, c]) => `${k}=${c.value}`).join("; ");
  }
  has(name) {
    this.purge();
    return this.map.has(name);
  }
}

/* ───────── 服务端：真实 proxy + 门闸路由，其余受保护接口回一个空的 200 ───────── */

export async function loadServer() {
  const { NextRequest } = await import("next/server");
  const { default: proxy } = await import("../../proxy.ts");
  const issue = await import("../../app/api/gate/issue/route.ts");
  const seed = await import("../../app/api/gate/seed/route.ts");
  const routes = {
    "GET /api/gate/issue": issue.GET,
    "POST /api/gate/issue": issue.POST,
    "GET /api/gate/seed": seed.GET,
  };
  async function handle(method, path, headers, body) {
    const url = `${ORIGIN}${path}`;
    const pres = await proxy(new NextRequest(url, { method, headers, body }));
    const setCookies = [...pres.headers.getSetCookie()];
    if (pres.headers.get("x-middleware-next") !== "1") return { res: pres, setCookies };
    const pathname = new URL(url).pathname;
    const route = routes[`${method} ${pathname}`];
    let res;
    if (route) res = await route(new Request(url, { method, headers, body }));
    else if (headers.accept?.startsWith("text/html")) res = new Response("<html></html>", { status: 200 });
    else res = Response.json({ ok: true, items: [], total: 0 });
    setCookies.push(...res.headers.getSetCookie());
    return { res, setCookies };
  }
  return { handle };
}

/* ───────── 浏览器标签页 ───────── */

export class Tab {
  constructor(server, ip) {
    this.server = server;
    this.ip = ip;
    this.jar = new CookieJar();
    const ss = new Map();
    this.sessionStorage = {
      getItem: (k) => (ss.has(k) ? ss.get(k) : null),
      setItem: (k, v) => void ss.set(k, String(v)),
      removeItem: (k) => void ss.delete(k),
      clear: () => ss.clear(),
      get length() {
        return ss.size;
      },
    };
    this.log = []; // { at, page, method, path, status }
    this.pageNo = 0;
    this.current = null;
  }

  baseHeaders() {
    const h = { "user-agent": CHROME, "cf-connecting-ip": this.ip, "accept-language": "zh-CN,zh;q=0.9" };
    const cookie = this.jar.header();
    if (cookie) h.cookie = cookie;
    return h;
  }

  async send(method, path, extra, body) {
    const headers = { ...this.baseHeaders(), ...extra };
    const { res, setCookies } = await this.server.handle(method, path, headers, body);
    this.jar.applySetCookie(setCookies);
    this.log.push({ at: Date.now(), page: this.pageNo, method, path, status: res.status });
    return res;
  }

  /**
   * 页面里的 fetch：同源、CORS 模式；非 GET 带 Origin（与 Chrome 一致）。
   * signal 在途中止时立即以 AbortError 结束，之后才到的响应（含 Set-Cookie）丢弃；服务端照常处理完，
   * 与浏览器在收到响应头之前中止请求时一致。
   */
  pageFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, ORIGIN);
    const path = u.pathname + u.search;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = {
      ...this.baseHeaders(),
      accept: "*/*",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      referer: `${ORIGIN}${this.current?.path ?? "/"}`,
      ...(method === "GET" ? {} : { origin: ORIGIN }),
      ...(init.headers ?? {}),
    };
    const sig = init.signal;
    const abortErr = () => sig.reason ?? new DOMException("Aborted", "AbortError");
    if (sig?.aborted) return Promise.reject(abortErr());
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        this.log.push({ at: Date.now(), page: this.pageNo, method, path, status: "aborted" });
        reject(abortErr());
      };
      sig?.addEventListener("abort", onAbort, { once: true });
      this.server.handle(method, path, headers, init.body).then(
        ({ res, setCookies }) => {
          if (done) return;
          done = true;
          sig?.removeEventListener("abort", onAbort);
          this.jar.applySetCookie(setCookies);
          this.log.push({ at: Date.now(), page: this.pageNo, method, path, status: res.status });
          resolve(res);
        },
        (e) => {
          if (done) return;
          done = true;
          sig?.removeEventListener("abort", onAbort);
          reject(e);
        }
      );
    });
  }

  /** 整页导航（含刷新）：新的 JS 环境，sessionStorage 与 cookie 保留 */
  async navigate(path, { reload = false } = {}) {
    this.current?.ctrl.abort(new DOMException("page unloaded", "AbortError"));
    const n = ++this.pageNo;
    const ctrl = new AbortController();
    const jar = this.jar;
    globalThis.window = new EventTarget();
    globalThis.sessionStorage = this.sessionStorage;
    globalThis.document = {
      get cookie() {
        return jar.forScript();
      },
      set cookie(v) {
        jar.applySetCookie([v]);
      },
    };
    globalThis.fetch = (input, init) => this.pageFetch(input, init);
    const res = await this.send("GET", path, {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-site": reload ? "none" : "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      ...(reload ? {} : { referer: `${ORIGIN}${this.current?.path ?? "/"}` }),
    });
    const fwt = await import(`../../lib/fetch-with-timeout.ts?page=${n}`);
    const gate = await import(`../../components/GateClient.tsx?page=${n}`);
    this.current = { n, path, ctrl, status: res.status };
    return {
      status: res.status,
      signal: ctrl.signal,
      /** 页面代码发受保护请求的唯一入口（与各 hooks 一致）；页面卸载后在途重试随之终止 */
      fetch: (url, init = {}) => fwt.fetchWithTimeout(url, { ...init, signal: init.signal ?? ctrl.signal }),
      /** 根布局挂载 GateClient（React 在子组件 effect 之后运行它） */
      mountGate: () => gate.GateClient(),
    };
  }

  /** 客户端路由跳转（Link）：不换 JS 环境、不发页面请求，只换 Referer */
  softNavigate(path) {
    this.current.path = path;
  }

  count(pred) {
    return this.log.filter(pred).length;
  }
}

/** 浏览器里的 SHA-256（crypto.subtle.digest）换成同步实现包一层 Promise：结果相同，PoW 从秒级降到百毫秒级 */
export function fastSubtleDigest(t) {
  t.mock.method(globalThis.crypto.subtle, "digest", async (_alg, data) => {
    const h = createHash("sha256").update(Buffer.from(data)).digest();
    return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
  });
}

/**
 * mock timers 下推进虚拟时钟直到 promise 落定：每步先让出若干轮事件循环（setImmediate 不被 mock），
 * 让已就绪的 I/O 与微任务跑完，再拨 step 毫秒。返回落定值与经过的虚拟毫秒数。
 */
export async function advanceUntil(t, promise, { step = 50, limitMs = 120_000 } = {}) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  const start = Date.now();
  while (!settled && Date.now() - start < limitMs) {
    for (let i = 0; i < 5 && !settled; i++) await new Promise((r) => setImmediate(r));
    if (!settled) t.mock.timers.tick(step);
  }
  return { value: await promise, elapsed: Date.now() - start };
}
