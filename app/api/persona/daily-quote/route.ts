import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { getPetMode } from "@/lib/persona/config";
import {
  dailyQuoteKey,
  dailyQuoteLockKey,
  dailyQuotePrompt,
  parseDailyQuote,
  pickSeedQuote,
  secondsUntilNextBeijingDay,
  todayInBeijing,
} from "@/lib/persona/daily-quote";
import { isLlmConfigured, streamChat } from "@/lib/persona/llm";
import { loadPersona } from "@/lib/persona/store";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";

/**
 * 右下角数字人上方的「每日一句」。
 *
 * 每天只生成一次：第一个访问者触发，结果按日期写入缓存，其余请求只读缓存。
 * 生成是花钱的动作，所以：持锁防并发、失败后冷却十分钟、没有缓存服务时整条功能静默关闭。
 * 句子只用 public 人设包（它会原样展示给所有人）；取不到就返回 204，前端什么都不显示。
 */
export const maxDuration = 60;

const QUOTE_MAX_TOKENS = 400;
const MODEL_TIMEOUT_MS = 45_000;
/** 持锁时长要覆盖模型超时，靠自然过期释放；请求被中断时 finally 也会释放 */
const LOCK_TTL_S = 60;
/** 失败冷却：供应商故障或不合格的输出，十分钟内不再重试，免得每个访问者都触发一次模型调用 */
const COOLDOWN_S = 10 * 60;
const RELEASE = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

function json(body: unknown, status: number) {
  return withAntiScrapeHeaders(NextResponse.json(body, { status }));
}

/** 「今天没有」的统一形态：204 空响应，前端据此不渲染，也不该被当成错误处理 */
function none() {
  return withAntiScrapeHeaders(new NextResponse(null, { status: 204 }));
}

function redisFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

function cooldownKey(date: string): string {
  return `${dailyQuoteKey(date)}:cooldown`;
}

async function readCachedQuote(redis: Redis, date: string): Promise<string | null> {
  const value = await redis.get<unknown>(dailyQuoteKey(date)).catch(() => null);
  if (typeof value === "string") return value.trim() || null;
  // 兼容早期写成对象的形态：只认 text 字段，绝不把 JSON 原样挂到界面上
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
    return (value as { text: string }).text.trim() || null;
  }
  return null;
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      // 一句话的正常输出只有几十个字；上游失控时及早放弃，别把长文读完整
      if (text.length > 4_000) throw new Error("输出过长");
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return text;
}

export async function GET(req: Request) {
  // 正常读者一天只会请求几次；限流只针对脚本，正常刷新不记违规
  const blocked = await guardApiRequest(req, {
    scope: "daily-quote",
    limit: 30,
    windowMs: 60_000,
    recordRateLimitViolation: false,
  });
  if (blocked) return blocked;
  if (getPetMode() === "off") return json({ error: "Not found" }, 404);

  const date = todayInBeijing();
  const redis = redisFromEnv();
  // 没有缓存服务就不做这件事：每次请求各生成一次，成本不可控
  if (!redis) return none();

  const cached = await readCachedQuote(redis, date);
  if (cached) return json({ date, text: cached }, 200);
  if (await redis.get(cooldownKey(date)).catch(() => null)) return none();
  if (!isLlmConfigured()) return none();

  const bundle = await loadPersona(false);
  if (!bundle) return none();

  const lockKey = dailyQuoteLockKey(date);
  const lockToken = randomUUID();
  const acquired = await redis.set(lockKey, lockToken, { nx: true, ex: LOCK_TTL_S }).catch(() => null);
  // 已有实例在生成：这次不排队，直接不显示，稍后刷新即得
  if (acquired !== "OK") return none();

  try {
    // 拿锁与首次查缓存之间可能已被另一实例写入，复查一次避免重复计费
    const again = await readCachedQuote(redis, date);
    if (again) return json({ date, text: again }, 200);

    const stream = await streamChat({
      system: dailyQuotePrompt(bundle, pickSeedQuote(date), date),
      messages: [{ role: "user", content: "写今天这一句。" }],
      maxTokens: QUOTE_MAX_TOKENS,
      temperature: 0.9,
      strict: true,
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
    });
    const quote = parseDailyQuote(await collectText(stream));
    if (!quote) {
      // 不合格的输出不缓存：下次重写；但先冷却，避免连续不合格时每次都烧一次调用
      await redis.set(cooldownKey(date), "1", { ex: COOLDOWN_S }).catch(() => {});
      return none();
    }
    // TTL 到次日零点再加一小时余量：实例间时钟或边界差异不该让同一天生成两次
    await redis.set(dailyQuoteKey(date), quote, { ex: secondsUntilNextBeijingDay() + 3_600 });
    return json({ date, text: quote }, 200);
  } catch (e) {
    if (!req.signal.aborted) {
      console.error("[daily-quote]", e instanceof Error ? `${e.name}: ${e.message}` : "error");
    }
    await redis.set(cooldownKey(date), "1", { ex: COOLDOWN_S }).catch(() => {});
    return none();
  } finally {
    await redis.eval(RELEASE, [lockKey], [lockToken]).catch(() => {});
  }
}
