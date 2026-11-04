/**
 * 客户端门闸状态的唯一来源。受保护接口的请求都经 lib/fetch-with-timeout.ts 走到这里，
 * 根布局的 GateClient 只是提前调一次 ensureGate()。
 *
 * 「是否持有有效 dr_gate」只看服务端随 dr_gate 一起写出、比它早 60 秒过期的提示 cookie
 * （lib/scrape-gate.ts setGateCookies）。客户端不另记标记：标记与凭据寿命不同源，凭据过期后
 * 标记还在，读者就会在 403 里打转直至 IP 被封（V2-4）。
 *
 * 握手（客户端二次握手）：
 *  1) 读 dr_seed（页面 GET 时中间件签发，非 HttpOnly，5 分钟）；没有就向 /api/gate/seed 现取一张。
 *  2) 解析 nonce → 计算 PoW → POST /api/gate/issue。
 *  3) 服务端校验 PoW + Sec-Fetch-Site 等指纹，签发 HttpOnly 的 dr_gate（48 小时）与提示。
 *
 * 该过程对真人无感（~100ms），但对脚本爬虫意味着：
 *  - 必须执行 JavaScript 才能拿到 nonce；
 *  - 必须自己跑 SHA-256 PoW（curl 一行做不到）；
 *  - 必须伪造 Sec-Fetch-Site / Mode / Dest 一整套头；
 *  - 失败 N 次直接进 honeypot 黑名单。
 */

const SEED_COOKIE = "dr_seed";
/** 与 lib/scrape-gate.ts 的 GATE_HINT_COOKIE 相同（那边依赖 node:crypto，客户端不能 import） */
const HINT_COOKIE = "dr_gate_hint";
/**
 * 握手各请求的超时：等待握手的受保护请求没有别的上限，握手必须保证会结束；又不能早于数据请求
 * 自己的预算（fetchWithTimeout 默认 30 秒）放弃，否则慢网下正文停在 403。
 */
const GATE_FETCH_TIMEOUT_MS = 30_000;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(
    new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)")
  );
  return m ? decodeURIComponent(m[1]) : null;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

/**
 * 计算 PoW：找一个 counter（十进制字符串），使
 *   sha256(seedNonce + ":" + counter)
 * 的 hex 前 difficulty 位都是 0。
 */
async function solvePow(seedNonce: string, difficulty: number): Promise<string> {
  const prefix = "0".repeat(difficulty);
  let i = 0;
  // 设上限避免极端情况死循环（4 位 0 平均 65 536 次，给 50 万足够安全）
  while (i < 500000) {
    const counter = String(i);
    const h = await sha256Hex(seedNonce + ":" + counter);
    if (h.startsWith(prefix)) return counter;
    i++;
  }
  throw new Error("PoW timeout");
}

function gateFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GATE_FETCH_TIMEOUT_MS);
  return fetch(url, { credentials: "same-origin", ...init, signal: ctrl.signal }).finally(() =>
    clearTimeout(timer)
  );
}

/** 拉取当前难度（也可硬编码 4，二者一致） */
async function fetchDifficulty(): Promise<number> {
  try {
    const r = await gateFetch("/api/gate/issue");
    if (r.ok) {
      const j = (await r.json()) as { difficulty?: number };
      if (typeof j.difficulty === "number" && j.difficulty > 0 && j.difficulty < 8) return j.difficulty;
    }
  } catch {
    /* 用默认 difficulty */
  }
  return 4;
}

async function handshake(): Promise<boolean> {
  let seed = readCookie(SEED_COOKIE);
  let difficulty = 0;
  // 第二轮只在 issue 回 403 时发生：多半是换了出口 IP（seed 绑 IP bucket），换一张 seed 再试一次
  for (let round = 0; round < 2; round++) {
    if (round > 0 || !seed) {
      // 没有 seed：标签页挂起超过 5 分钟、或只做过客户端跳转，没有页面 GET 来签发
      const before = seed;
      await gateFetch("/api/gate/seed");
      seed = readCookie(SEED_COOKIE);
      if (!seed || seed === before) return false;
    }
    // seed 格式是 4 段：exp.nonce.ipBucket.sig
    const parts = seed.split(".");
    if (parts.length !== 4 || !parts[1]) return false;
    difficulty ||= await fetchDifficulty();
    const counter = await solvePow(parts[1], difficulty);
    if (readCookie(HINT_COOKIE)) return true; // 算 PoW 期间别的标签页已握手成功：同一张 seed 再兑换会判重放
    const res = await gateFetch("/api/gate/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ counter }),
    });
    if (res.ok) return true;
    if (res.status !== 403) return false;
  }
  return false;
}

let pending: Promise<boolean> | null = null;

/**
 * 等到本浏览器持有有效 dr_gate（以提示 cookie 为准）。并发调用共用同一次握手；
 * 握手失败（没网、被封、不支持 crypto.subtle）返回 false，由调用方照常发请求、拿真实响应。
 */
export function ensureGate(): Promise<boolean> {
  if (pending) return pending;
  if (readCookie(HINT_COOKIE)) return Promise.resolve(true);
  pending = handshake()
    .catch(() => {
      // 中止或网络失败：服务端可能已兑换这张 seed，留着它下次握手会撞重放，丢掉后现取新的
      document.cookie = `${SEED_COOKIE}=; Max-Age=0; Path=/`;
      return false;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** 提示说有凭据、受保护接口却回了 403（AUTH_SECRET 轮换、凭据被单独删掉）：作废提示，下次 ensureGate() 重新握手 */
export function invalidateGate(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${HINT_COOKIE}=; Max-Age=0; Path=/`;
}
