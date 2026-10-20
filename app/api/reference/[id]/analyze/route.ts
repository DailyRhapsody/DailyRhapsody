import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import { buildCompanyContext } from "@/lib/company-context";
import { parseSkillCard } from "@/lib/company-skill-card";
import { buildCompanySystemPrompt } from "@/lib/company-skill-prompts";
import {
  COMPANY_SKILL_PROMPT_VERSION,
  findCompanySkill,
} from "@/lib/company-skills";
import { renderMarkdown } from "@/lib/markdown";
import {
  getReferenceItem,
  isReferenceConfigured,
} from "@/lib/notion-reference";
import { isLlmConfigured, streamChat } from "@/lib/persona/llm";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";
import { limitByIp } from "@/lib/upstash-rate-limit";

export const maxDuration = 60;

const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_OUTPUT_CHARS = 20_000;

function json(body: unknown, status: number) {
  return withAntiScrapeHeaders(NextResponse.json(body, { status }));
}

function redisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function cacheNamespace(): string {
  const environment =
    process.env.VERCEL_ENV || (process.env.NODE_ENV === "production" ? "production" : "local");
  return `dr:reference:analysis:${environment}:${COMPANY_SKILL_PROMPT_VERSION}`;
}

type CachedResult = { text: string; at: number };

async function readCache(redis: Redis, key: string): Promise<CachedResult | null> {
  try {
    const value = await redis.get<CachedResult>(key);
    if (!value || typeof value.text !== "string" || !value.text.trim()) return null;
    return { text: value.text, at: Number(value.at) || Date.now() };
  } catch {
    return null;
  }
}

async function writeCache(redis: Redis, key: string, value: CachedResult): Promise<void> {
  try {
    await redis.set(key, value, { ex: CACHE_TTL_SECONDS });
  } catch {
    // 缓存失败不影响本次结果
  }
}

function failureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return "分析超时，请稍后重试。";
  }
  return "本次分析未完成，请稍后重试。";
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const cross = rejectCrossSiteWrite(req);
  if (cross) return cross;

  const blocked = await guardApiRequest(req, {
    scope: "reference:analyze",
    limit: 12,
    windowMs: 60_000,
    blockSuspicious: false,
  });
  if (blocked) return blocked;

  if (!isReferenceConfigured()) {
    return json({ error: "资料库暂不可用。" }, 503);
  }

  let body: { skill?: unknown; lang?: unknown };
  try {
    body = (await req.json()) as { skill?: unknown; lang?: unknown };
  } catch {
    return json({ error: "请求体无效" }, 400);
  }

  const skill = findCompanySkill(body.skill);
  if (!skill) return json({ error: "未知分析技能" }, 400);
  const lang = body.lang === "en" ? "en" : "zh";

  const { id } = await params;
  const item = await getReferenceItem(id);
  const admin = await isAdmin();
  if (!item || (!admin && !item.isPublic)) {
    return json({ error: "条目不存在" }, 404);
  }
  if (item.kind !== "company" || !item.company) {
    return json({ error: "该条目不是公司档案" }, 422);
  }

  const context = buildCompanyContext(item);
  const digest = createHash("sha256").update(context).digest("hex").slice(0, 16);
  const cacheKey = `${cacheNamespace()}:${item.id}:${skill.id}:${digest}:${lang}`;
  const redis = redisClient();

  if (redis) {
    const cached = await readCache(redis, cacheKey);
    if (cached) {
      return json(
        {
          skill: skill.id,
          text: cached.text,
          html: renderMarkdown(cached.text),
          card: parseSkillCard(cached.text),
          cachedAt: cached.at,
          cached: true,
        },
        200
      );
    }
  }

  if (!isLlmConfigured()) {
    return json({ error: "未配置大模型接口。" }, 503);
  }

  const ip = getClientIpFromRequest(req);
  const allowed = await limitByIp("reference:analysis:global", "all", 200, "1 d", {
    failClosed: true,
  });
  if (!allowed) {
    return json({ error: "今日分析额度已用完，请明天再试。" }, 429);
  }

  const built = buildCompanySystemPrompt(skill.id);
  const system = `${built.system}\n7. 用${lang === "en" ? "英文" : "简体中文"}输出。`;

  try {
    const stream = await streamChat({
      system,
      messages: [{ role: "user", content: `请分析下面这家公司。\n\n${context}` }],
      maxTokens: built.maxTokens,
      temperature: built.temperature,
      strict: true,
      signal: AbortSignal.timeout(55_000),
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        if (raw.length > MAX_OUTPUT_CHARS) throw new Error("分析输出过长");
      }
      raw += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const text = raw.trim();
    if (!text) throw new Error("模型返回为空");
    const at = Date.now();
    if (redis) await writeCache(redis, cacheKey, { text, at });
    return json(
      {
        skill: skill.id,
        text,
        html: renderMarkdown(text),
        card: parseSkillCard(text),
        cachedAt: at,
        cached: false,
      },
      200
    );
  } catch (error) {
    console.error(
      "[reference-analyze]",
      skill.id,
      ip ? "ip" : "",
      error instanceof Error ? `${error.name}: ${error.message}` : "error"
    );
    return json({ error: failureMessage(error) }, 502);
  }
}
