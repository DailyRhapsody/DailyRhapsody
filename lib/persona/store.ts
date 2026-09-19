import { readFile } from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { parsePersonaBundle, type PersonaBundle, type PersonaTier } from "@/lib/persona/types";

/**
 * 人设包读取。
 *
 * - public 包：线上从 Upstash 读；每个实例内存缓存 60 秒，避免每轮对话都把几百 KB 从 Redis 拉一遍。
 * - owner 包（全部记忆）：只在本机开发环境从 PERSONA_BUNDLE_DIR 读，线上任何位置都不存放。
 *   管理员登录一旦被攻破，攻击者能套出的上限就是线上存放的内容，所以全部记忆不上线。
 *
 * 带版本号的 key：Preview 与生产共用同一个 Upstash，改包结构时换 v2，旧部署仍读得到 v1。
 */
const KEY_PREFIX = "dr:persona";
const KEY_VERSION = "v1";
const MEMO_TTL_MS = 60_000;

export function personaKey(tier: PersonaTier): string {
  return `${KEY_PREFIX}:${tier}:${KEY_VERSION}`;
}

let _redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

const memo = new Map<PersonaTier, { at: number; bundle: PersonaBundle | null }>();

/**
 * 本地调试口：非生产环境下设置 PERSONA_BUNDLE_DIR，就从该目录读 public.json / owner.json，
 * 不碰线上 Redis。本地 .env.local 里的 KV 凭证指向的就是生产库。
 */
async function readFromDir(tier: PersonaTier): Promise<unknown> {
  const dir = process.env.PERSONA_BUNDLE_DIR?.trim();
  if (!dir || process.env.NODE_ENV === "production") return undefined;
  try {
    return JSON.parse(await readFile(path.join(dir, `${tier}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function loadTier(tier: PersonaTier): Promise<PersonaBundle | null> {
  const hit = memo.get(tier);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.bundle;

  let raw = await readFromDir(tier);
  // owner 包没有线上来源：本地目录没有就是没有，不去 Redis 找
  if (raw === undefined && tier === "public") {
    const redis = getRedis();
    raw = redis ? await redis.get(personaKey(tier)).catch(() => null) : null;
  }
  const bundle = parsePersonaBundle(raw, tier);
  memo.set(tier, { at: Date.now(), bundle });
  return bundle;
}

/**
 * 管理员请求优先用 owner 包；线上与本地未准备 owner 包时退回 public 包。
 * 调用方以返回包的 tier 为准决定提示词与检索范围，不以请求者身份为准。
 */
export async function loadPersona(preferOwner: boolean): Promise<PersonaBundle | null> {
  if (preferOwner) {
    const owner = await loadTier("owner");
    if (owner) return owner;
  }
  return loadTier("public");
}
