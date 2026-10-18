/**
 * Reference 点赞（匿名设备号）。
 *
 * 目的：低门槛的「有用」信号，不追求一人一票。设备 id 只是随机 128-bit，
 * 存在 HttpOnly 签名 cookie 里；清 cookie / 无痕可以重刷，接受这一点，
 * 用 IP 日上限兜底，UI 不把它包装成严肃投票。
 *
 * 与管理员会话（AUTH_SECRET）分开派生密钥：轮换管理员密钥时不能把全部
 * 点赞身份一起重置，否则同一个人会再赞一轮、计数翻倍。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";

const COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-dr_like" : "dr_like";
const MAX_AGE_S = 365 * 24 * 60 * 60;
const PAYLOAD_PREFIX = "v1";
const SIGN_PREFIX = "like:v1:";
const LIKE_SET_PREFIX = "dr:ref:likes:";

export type LikeState = { count: number; liked: boolean };

function likeSecret(): string {
  const explicit = process.env.LIKE_COOKIE_SECRET?.trim();
  if (explicit && explicit.length >= 16) return explicit;
  const auth = process.env.AUTH_SECRET;
  if (!auth || auth.length < 16) {
    throw new Error("Set AUTH_SECRET (min 16 chars) or LIKE_COOKIE_SECRET");
  }
  // HKDF 风格派生：同一个 AUTH_SECRET 下，点赞 cookie 与管理会话互不通用
  return createHmac("sha256", auth).update("like-cookie-v1").digest("hex");
}

function sign(payload: string): string {
  return createHmac("sha256", likeSecret()).update(SIGN_PREFIX + payload).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function newDeviceId(): string {
  return randomBytes(16).toString("hex");
}

/** 从 Cookie 头读设备 id；验签失败/过期一律当没有。 */
export function readLikeDeviceId(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const prefix = `${COOKIE_NAME}=`;
  const part = cookieHeader
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(prefix));
  if (!part) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(part.slice(prefix.length));
  } catch {
    // 畸形百分号编码：当没有 cookie，不要让一个请求打成 500
    return null;
  }
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/i.test(sig)) return null;
  if (!safeEqualHex(sig, sign(payload))) return null;

  const [version, did, iatRaw] = payload.split(".");
  if (version !== PAYLOAD_PREFIX || !/^[0-9a-f]{32}$/.test(did ?? "")) return null;
  const iat = Number(iatRaw);
  if (!Number.isFinite(iat) || iat <= 0) return null;
  if (Date.now() - iat > MAX_AGE_S * 1000) return null;
  return did;
}

/** 生成 Set-Cookie 值。did 不变，只重签，避免续期时身份漂移。 */
export function mintLikeCookie(did: string): string {
  const payload = `${PAYLOAD_PREFIX}.${did}.${Date.now()}`;
  const value = `${payload}.${sign(payload)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  // __Host- 前缀要求 Path=/、无 Domain、Secure；生产用 HTTPS，满足条件
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure}`;
}

export function newLikeDeviceId(): string {
  return newDeviceId();
}

let _redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

export function isReferenceLikesConfigured(): boolean {
  return getRedis() !== null;
}

const likeKey = (id: string) => `${LIKE_SET_PREFIX}${id}`;

/** 点赞/取消赞。action 显式，不用 toggle：重复请求必须幂等。 */
export async function setReferenceLike(
  id: string,
  deviceId: string,
  action: "like" | "unlike"
): Promise<LikeState | null> {
  const redis = getRedis();
  if (!redis) return null;
  const key = likeKey(id);
  if (action === "like") await redis.sadd(key, deviceId);
  else await redis.srem(key, deviceId);
  const [count, member] = await Promise.all([redis.scard(key), redis.sismember(key, deviceId)]);
  return { count: Number(count) || 0, liked: Number(member) === 1 };
}

/** 批量取计数与「我赞过」。最多 30 条，一次 pipeline。 */
export async function getReferenceLikes(
  ids: string[],
  deviceId: string | null
): Promise<Record<string, LikeState>> {
  const redis = getRedis();
  const out: Record<string, LikeState> = {};
  for (const id of ids) out[id] = { count: 0, liked: false };
  if (!redis || ids.length === 0) return out;

  const pipe = redis.pipeline();
  for (const id of ids) {
    pipe.scard(likeKey(id));
    if (deviceId) pipe.sismember(likeKey(id), deviceId);
  }
  const raw = await pipe.exec();
  let cursor = 0;
  for (const id of ids) {
    const count = Number(raw[cursor++]) || 0;
    const liked = deviceId ? Number(raw[cursor++]) === 1 : false;
    out[id] = { count, liked };
  }
  return out;
}
