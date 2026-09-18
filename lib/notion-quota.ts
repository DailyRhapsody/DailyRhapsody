/**
 * 保护 Notion 限流额度的两道闸。
 *
 * Notion 按 integration token 限速（约 3 req/s），生产、Preview、本地所有用同一个
 * NOTION_TOKEN 的进程共用这一份额度。2026-09-18 事故：另一个工作区的 next dev 用生产
 * token 配本地内存 Redis，缓存每 5 分钟过期就全量重拉一次（本地没有 maxDuration 兜底），
 * 生产的全量刷新与图片换签随之持续 429，Retry-After 从 8s 涨到 53s。
 *
 * 1. 本地开发（next dev）默认不调用 Notion API，显式设 NOTION_ALLOW_DEV_FETCH=1 才放行。
 * 2. 全量刷新用 Redis 锁保证全站同一时刻只跑一份（之前只在单实例内去重，线上观察到两个
 *    实例各跑一份）；刷新失败后锁不删除、改为冷却期，避免后续每个请求都再发起一轮注定
 *    撞限的刷新。
 */
import { randomUUID } from "crypto";
import type { Redis } from "@upstash/redis";

/** next dev 下默认禁止回源；生产构建里 NODE_ENV 在编译期就被替换成 "production"。 */
export function isNotionFetchAllowed(): boolean {
  return process.env.NODE_ENV !== "development" || process.env.NOTION_ALLOW_DEV_FETCH === "1";
}

export function assertNotionFetchAllowed(): void {
  if (isNotionFetchAllowed()) return;
  throw new Error(
    "本地开发默认不调用 Notion API：NOTION_TOKEN 与生产共用限流额度。" +
      "确需回源时换用单独的 integration token，并设 NOTION_ALLOW_DEV_FETCH=1。"
  );
}

// 锁的最长持有时间与各路由 maxDuration（300s）对齐：实例在刷新途中被平台终止时，锁最迟这么久后自动失效
const LOCK_TTL_S = 300;
// 刷新失败后的冷却期：期间所有实例都不再发起后台刷新，访客继续看旧缓存
const FAILURE_COOLDOWN_S = 120;

// 只处理自己持有的锁：锁过期后被别的实例拿走时，不能误删或误改对方的锁
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;
const COOLDOWN_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) end return 0`;

type RefreshLock = {
  /** false：别的实例正在刷新，或上一轮失败后仍在冷却期 */
  acquired: boolean;
  release(): Promise<void>;
  cooldown(): Promise<void>;
};

const noop = async () => {};

async function acquireRefreshLock(redis: Redis | null, key: string): Promise<RefreshLock> {
  // 没配 Redis 就无法跨实例协调，退回单实例去重（与改动前一致）
  if (!redis) return { acquired: true, release: noop, cooldown: noop };
  const token = randomUUID();
  let result: unknown;
  try {
    result = await redis.set(key, token, { nx: true, ex: LOCK_TTL_S });
  } catch {
    // Redis 故障时放行：缓存本身也读写不了，锁不住的代价只是重复刷新（与改动前一致）
    return { acquired: true, release: noop, cooldown: noop };
  }
  if (result !== "OK") return { acquired: false, release: noop, cooldown: noop };
  return {
    acquired: true,
    release: async () => {
      try {
        await redis.eval(RELEASE_SCRIPT, [key], [token]);
      } catch {
        // 删不掉就等 TTL 自然过期
      }
    },
    cooldown: async () => {
      try {
        await redis.eval(COOLDOWN_SCRIPT, [key], [token, FAILURE_COOLDOWN_S]);
      } catch {
        // 改不了就按原 TTL 过期，同样起到冷却作用
      }
    },
  };
}

/**
 * 在跨实例锁内跑一轮刷新。拿不到锁时，后台刷新直接放弃并返回 null；force（冷启动没有旧数据可返回、
 * Cron 每日预热）照跑，但拿得到锁时照样占住，让其他实例的后台刷新让路。
 * 成功后释放锁；失败时把锁留作冷却期再抛出。任何失败都进冷却：共用 token 的 Preview 若有缺陷，
 * 反复重试同样会耗掉生产的额度。refresh 收到的 holdsLock 表示这一轮是否真的持有锁。
 */
export async function runWithRefreshLock<T>(
  redis: Redis | null,
  key: string,
  force: boolean,
  refresh: (holdsLock: boolean) => Promise<T>
): Promise<T | null> {
  // 先过开发开关再拿锁：本地被拦下的请求若先占了锁，失败时会给共享 Redis 里的锁写上冷却期，把生产的刷新也挡住
  assertNotionFetchAllowed();
  const lock = await acquireRefreshLock(redis, key);
  if (!lock.acquired && !force) return null;
  try {
    const result = await refresh(lock.acquired);
    await lock.release();
    return result;
  } catch (e) {
    await lock.cooldown();
    throw e;
  }
}
