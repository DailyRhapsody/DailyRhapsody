import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { NextResponse } from "next/server";

/**
 * 防爬「双 cookie + 客户端二次握手」机制：
 *  1) 中间件在 GET 页面时签发 dr_seed（短期、非 HttpOnly，绑定 client IP）。
 *     它本身不能访问受保护接口。
 *  2) 客户端 JS 必须用 fetch() 调用 /api/gate/issue（同源 + Sec-Fetch-Site 强校验
 *     + 计算 PoW），换取真正的 dr_gate（长 TTL、HttpOnly）。
 *  3) 受保护接口只接受 dr_gate。
 *
 * 二轮渗透发现的关键加固：
 *  - seed 现在 HMAC 绑定 client IP bucket：换 IP 就废，杜绝"算一次 PoW 给整个代理池用"。
 *  - issue 接口配合 markNonceUsed() 让同一 seed nonce 只能兑换一次（如果配了 Upstash）。
 */

export const SCRAPE_SEED_COOKIE = "dr_seed";
export const SCRAPE_GATE_COOKIE = "dr_gate";

export const SEED_TTL_MS = 5 * 60 * 1000;
export const GATE_TTL_MS = 48 * 60 * 60 * 1000;

/** PoW 难度：要求 SHA-256(seedNonce + ":" + counter) 的 hex 前 N 位等于 0。
 *  4 ≈ 平均 65 536 次哈希，浏览器 ~100ms；不影响真人体验，但给批量自动化加成本。 */
export const POW_DIFFICULTY = 4;

function gateSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET (min 16 chars) is required for scrape gate");
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", gateSecret()).update(payload).digest("hex");
}

/**
 * 把 client IP 折叠成一个 16 字符的 bucket。
 * 用 HMAC 而不是裸 sha256，避免攻击者离线穷举所有 /24 子网映射。
 * "unknown" / 空字符串视为同一桶（dev 直连场景），但 verify 时仍要求一致。
 *
 * v2: 改为子网粒度（IPv4 /24，IPv6 /48），缓解真人 WiFi↔4G 切换 / 公司出口轮换 IP
 * 导致 dr_seed 5min 内失效的体验问题。同子网内攻击者仍需各自跑 PoW，安全衰减可忽略。
 */
function ipSubnet(clientIp: string): string {
  const raw = clientIp.trim();
  if (!raw || raw === "unknown") return "unknown";

  // IPv4 映射的 IPv6 (::ffff:1.2.3.4) 当作 IPv4 处理
  const v4Mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const ip = v4Mapped ? v4Mapped[1] : raw;

  if (isIPv4(ip)) {
    const p = ip.split(".");
    return `v4:${p[0]}.${p[1]}.${p[2]}.0/24`;
  }

  if (isIPv6(ip)) {
    // 展开压缩形式：把 :: 还原为足额的 0 段，统一成 8 段
    const hasDoubleColon = ip.includes("::");
    let segments: string[];
    if (hasDoubleColon) {
      const [head, tail] = ip.split("::");
      const headParts = head ? head.split(":") : [];
      const tailParts = tail ? tail.split(":") : [];
      const fillCount = 8 - headParts.length - tailParts.length;
      segments = [
        ...headParts,
        ...Array(Math.max(0, fillCount)).fill("0"),
        ...tailParts,
      ];
    } else {
      segments = ip.split(":");
    }
    // 规范化每段（去前导 0、转小写）
    const norm = segments.map((s) => (s === "" ? "0" : parseInt(s, 16).toString(16)));
    // 兜底：长度不足 8 段的异常输入直接归为 unknown 桶（不应到这里，isIPv6 已校验）
    if (norm.length !== 8) return "v6:malformed";
    // /48 = 取前 3 段，其余清零
    return `v6:${norm[0]}:${norm[1]}:${norm[2]}::/48`;
  }

  // 无法识别的格式：当作 unknown 一桶（dev/异常场景）
  return "unknown";
}

function ipBucket(clientIp: string | null | undefined): string {
  const ip = (clientIp ?? "").trim() || "unknown";
  const subnet = ipSubnet(ip);
  return createHmac("sha256", gateSecret()).update(`ip:${subnet}`).digest("hex").slice(0, 16);
}

/** 3 段 token：用于 dr_gate（不绑 IP，允许真人换 WiFi）。 */
function mintGateToken(ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const nonce = randomBytes(12).toString("hex");
  const payload = `${exp}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

function parseAndVerifyGate(raw: string | undefined):
  | { exp: number; nonce: string }
  | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = sign(`${expStr}.${nonce}`);
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return { exp, nonce };
}

/** 4 段 token：用于 dr_seed（绑定 client IP）。 */
export function mintSeedValue(clientIp: string): string {
  const exp = Date.now() + SEED_TTL_MS;
  const nonce = randomBytes(12).toString("hex");
  const bucket = ipBucket(clientIp);
  const payload = `${exp}.${nonce}.${bucket}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * 校验 seed cookie。
 *  - exp 未过期
 *  - HMAC 签名正确
 *  - 绑定的 ipBucket 等于当前请求的 ipBucket（关键：换 IP 即废）
 */
export function verifySeedValue(
  raw: string | undefined,
  clientIp: string
): { nonce: string } | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [expStr, nonce, bucket, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = sign(`${expStr}.${nonce}.${bucket}`);
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  // 关键防重放：bucket 必须与当前 IP 匹配
  const currentBucket = ipBucket(clientIp);
  const ba = Buffer.from(bucket, "hex");
  const bb = Buffer.from(currentBucket, "hex");
  if (ba.length !== bb.length) return null;
  if (!timingSafeEqual(ba, bb)) return null;
  return { nonce };
}

export function mintGateValue(): string {
  return mintGateToken(GATE_TTL_MS);
}

export function verifyGateValue(raw: string | undefined): boolean {
  return parseAndVerifyGate(raw) !== null;
}

/** 脚本可读的「持有 dr_gate」提示，值无意义。客户端（lib/gate-handshake.ts）只凭它决定要不要握手。 */
export const GATE_HINT_COOKIE = "dr_gate_hint";

/**
 * 签发与续期 dr_gate 的唯一入口：凭据与提示同一处写出，客户端的判断与凭据同源。
 * 提示比凭据早 60 秒过期：token 的到期时间签发时就定了，浏览器收到响应才开始计 Max-Age，
 * 留出提前量，客户端换新凭据时旧凭据一定还有效，不会在最后一刻撞上 403。
 */
export function setGateCookies(res: NextResponse): void {
  const maxAge = Math.floor(GATE_TTL_MS / 1000);
  const base = { path: "/", sameSite: "lax", secure: process.env.NODE_ENV === "production" } as const;
  res.cookies.set(SCRAPE_GATE_COOKIE, mintGateValue(), { ...base, httpOnly: true, maxAge });
  res.cookies.set(GATE_HINT_COOKIE, "1", { ...base, maxAge: maxAge - 60 });
}

/**
 * 判断 dr_gate 是否临近过期（剩余 < threshold ms）。
 * 用于让 proxy 在用户访问受保护路径时自动续期，避免正在浏览过程中突然失效。
 */
export function gateExpiringSoon(
  raw: string | undefined,
  thresholdMs: number = 2 * 60 * 60 * 1000 // 默认最后 2h
): boolean {
  const parsed = parseAndVerifyGate(raw);
  if (!parsed) return false;
  return parsed.exp - Date.now() < thresholdMs;
}

/** 校验客户端提交的 PoW：sha256(seedNonce + ":" + counter) 必须以 difficulty 个 0 开头。 */
export function checkPow(
  seedNonce: string,
  counter: string,
  difficulty: number = POW_DIFFICULTY
): boolean {
  if (typeof counter !== "string") return false;
  if (counter.length === 0 || counter.length > 32) return false;
  // 限制只允许十进制数字，避免攻击者塞入超长 utf-8
  if (!/^\d+$/.test(counter)) return false;
  const h = createHash("sha256")
    .update(`${seedNonce}:${counter}`)
    .digest("hex");
  const prefix = "0".repeat(difficulty);
  return h.startsWith(prefix);
}
