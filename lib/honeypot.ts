import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

const redis =
  url && token
    ? new Redis({ url, token })
    : null;

const BLOCK_PREFIX = "dr:blocked:";
const VIOL_PREFIX = "dr:viol:";
const NONCE_PREFIX = "dr:gate:nonce:";
const BLOCK_DURATION_S = 60 * 60 * 24; // 封禁 24 小时
const VIOL_WINDOW_S = 60 * 10; // 违规计数窗口 10 分钟
const VIOL_THRESHOLD = 4; // 10 分钟内累计 4 次违规即自动封禁
const NONCE_TTL_S = 60 * 5; // 与 SEED_TTL_MS 对齐

export async function blockIp(ip: string, reason: string) {
  if (!redis) return;
  if (!ip || ip === "unknown") return;
  console.warn(`Blocking IP ${ip} for ${reason}`);
  await redis.set(`${BLOCK_PREFIX}${ip}`, {
    ip,
    reason,
    at: new Date().toISOString(),
  }, { ex: BLOCK_DURATION_S });
}

export async function isIpBlocked(ip: string): Promise<boolean> {
  if (!redis) return false;
  if (!ip || ip === "unknown") return false;
  const blocked = await redis.get(`${BLOCK_PREFIX}${ip}`);
  return !!blocked;
}

/**
 * 返回封禁剩余秒数：未封禁或 Redis 不可用返回 0。
 * 提示页与 Retry-After 需要真实剩余时长，硬编码 24 小时会在 TTL 调整后变成错话。
 */
export async function blockedTtlSeconds(ip: string): Promise<number> {
  if (!redis) return 0;
  if (!ip || ip === "unknown") return 0;
  try {
    const ttl = await redis.ttl(`${BLOCK_PREFIX}${ip}`);
    return typeof ttl === "number" && ttl > 0 ? ttl : 0;
  } catch {
    return 0;
  }
}

/**
 * 解除指定 IP 的封禁 + 清空未达阈值的违规计数。
 * 用于 admin 在自己或可信用户被误封时的手动救济。
 */
export async function unblockIp(ip: string): Promise<{ removed: number }> {
  if (!redis) return { removed: 0 };
  if (!ip || ip === "unknown") return { removed: 0 };
  const removed = await redis.del(`${BLOCK_PREFIX}${ip}`, `${VIOL_PREFIX}${ip}`);
  return { removed: typeof removed === "number" ? removed : 0 };
}

/**
 * 标记一个 seed nonce 为「已兑换」。返回 true 表示首次写入成功（可放行兑换），
 * false 表示该 nonce 之前已被使用过（重放攻击，必须拒绝）。
 *
 * 没有 Redis 时返回 true（仅依赖 IP 绑定兜底）。
 */
export async function markNonceUsed(nonce: string): Promise<boolean> {
  if (!redis) return true;
  if (!nonce) return false;
  try {
    const res = await redis.set(`${NONCE_PREFIX}${nonce}`, "1", {
      nx: true,
      ex: NONCE_TTL_S,
    });
    return res === "OK";
  } catch (e) {
    console.warn("markNonceUsed failed", e);
    // Redis 故障时不要让真人卡住
    return true;
  }
}

/**
 * 记一次违规（命中限流 / 可疑特征 / 跨域抓取等）。
 * 短窗口内累计达到阈值会自动封禁该 IP 24 小时。
 */
export async function recordViolation(ip: string, reason: string): Promise<void> {
  if (!redis) return;
  if (!ip || ip === "unknown") return;
  const key = `${VIOL_PREFIX}${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, VIOL_WINDOW_S);
    }
    if (count >= VIOL_THRESHOLD) {
      await blockIp(ip, `Auto-block: ${count} violations in ${VIOL_WINDOW_S}s. Last: ${reason}`);
      // 清空计数避免后续误触
      await redis.del(key);
    }
  } catch (e) {
    console.warn("recordViolation failed", e);
  }
}
