import { Ratelimit, type Duration } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

const redis =
  url && token
    ? new Redis({ url, token })
    : null;

const limiters = new Map<string, Ratelimit>();

/** 失败即拒绝的实例用的超时：库默认 5s 超时后放行，花钱的接口宁可拒绝 */
const FAIL_CLOSED_TIMEOUT_MS = 3000;

function getLimiter(scope: string, limit: number = 60, window: Duration = "1 m", failClosed = false) {
  if (!redis) return null;
  const key = `${scope}:${limit}:${window}:${failClosed ? "closed" : "open"}`;
  if (!limiters.has(key)) {
    limiters.set(key, new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, window),
      prefix: `dr:rl:${scope}`,
      analytics: false,
      ...(failClosed ? { timeout: FAIL_CLOSED_TIMEOUT_MS } : {}),
    }));
  }
  return limiters.get(key)!;
}

export function isUpstashConfigured(): boolean {
  return !!redis;
}

/**
 * failClosed：Redis 迟滞超时按「拒绝」处理（库默认超时放行）；Redis 报错照常抛出，由调用方决定。
 * 只给花钱的接口用，其他作用域保持原有的超时放行。
 */
export async function limitByIp(
  scope: string,
  ip: string,
  limit?: number,
  window?: Duration,
  opts?: { failClosed?: boolean },
): Promise<boolean> {
  const failClosed = !!opts?.failClosed;
  const l = getLimiter(scope, limit, window, failClosed);
  if (!l) return true;
  const { success, reason } = await l.limit(ip);
  return failClosed ? success && reason !== "timeout" : success;
}
