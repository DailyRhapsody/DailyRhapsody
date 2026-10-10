import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { getAnalysisDiaries } from "@/lib/notion";
import { withAntiScrapeHeaders } from "@/lib/request-guard";
import { streamChat } from "@/lib/persona/llm";
import {
  ANALYSIS_VERSION, analysisPrompt, makeCorpus, parseJson, planAnalysis,
  renderAnalysis, validateExtraction, validateNote, validateSynthesis, type Corpus,
} from "@/lib/persona/first-principles";

const TTL_SECONDS = 7 * 24 * 60 * 60;
const RELEASE = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

function json(body: unknown, status: number) {
  return withAntiScrapeHeaders(NextResponse.json(body, { status }));
}
function pending(completed: number, total: number, phase: "sources" | "extract" | "synthesize") {
  return json({ status: "processing", phase, completed, total, retryAfterMs: 9_000 }, 202);
}
function namespace(): string {
  const environment = process.env.VERCEL_ENV || (process.env.NODE_ENV === "production" ? "production" : "local");
  return `dr:blog:first-principles:${ANALYSIS_VERSION}:${environment}`;
}
async function unchanged(corpus: Corpus): Promise<boolean> {
  const latest = await getAnalysisDiaries();
  return latest !== null && makeCorpus(latest).hash === corpus.hash;
}

/** 一个请求最多一次模型调用，逐批持久化。任何访客均只分析公开博客，与人设记忆隔离。 */
export async function runFirstPrinciples(req: Request, authorizeModel: () => Promise<Response | null>): Promise<Response> {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return json({ error: "文章分析暂时不可用，请稍后再试。" }, 503);
  const redis = new Redis({ url, token });
  const prefix = namespace();
  const diaries = await getAnalysisDiaries();
  if (diaries === null) return pending(0, 0, "sources");
  const corpus = makeCorpus(diaries);
  if (!corpus.articles.length) return json({ error: "暂时没有可分析的公开文章。" }, 422);
  const read = async (keys: string[]) => {
    const values: unknown[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      values.push(...await redis.mget(...keys.slice(i, i + 100).map((k) => `${prefix}:${k}`)));
    }
    return values;
  };
  const plan = await planAnalysis(corpus, read);
  if (plan.result) {
    if (!await unchanged(corpus)) return pending(0, corpus.articles.length, "sources");
    return withAntiScrapeHeaders(new NextResponse(renderAnalysis(corpus, plan.result), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Persona-Tier": "public" },
    }));
  }
  let work = plan.work!;
  // 一个跨实例锁限制全站并发开销。Redis 故障不绕过锁；释放只接受自己的 token。
  const lockKey = `${prefix}:build-lock`, lockToken = randomUUID();
  const acquired = await redis.set(lockKey, lockToken, { nx: true, ex: 70 });
  if (acquired !== "OK") return pending(plan.completed, plan.total, work.phase);
  try {
    // 规划与拿锁之间可能已有另一请求提交，重规划避免重复计费。
    const lockedPlan = await planAnalysis(corpus, read);
    if (lockedPlan.result) return pending(lockedPlan.completed, lockedPlan.total, "synthesize");
    work = lockedPlan.work!;
    const rejected = await authorizeModel();
    if (rejected) return rejected;
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]);
    const stream = await streamChat({ system: analysisPrompt(work),
      messages: [{ role: "user", content: work.input }], maxTokens: 6_144,
      temperature: 0.2, strict: true, signal });
    const reader = stream.getReader(), decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > 64_000) throw new Error("分析输出过长");
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    signal.throwIfAborted();
    const raw = parseJson(text);
    const entries = work.phase === "extract"
      ? [...validateExtraction(raw, work.chunks!)].map(([key, value]) => [`chunk:${key}`, value] as const)
      : [[work.key, validateSynthesis(raw, work, corpus)]] as const;
    // 生成期间改文、删除或转私密：不发布旧报告，也不继续写入旧依据。
    if (!await unchanged(corpus)) return pending(0, plan.total, "sources");
    const pipeline = redis.pipeline();
    for (const [key, value] of entries) pipeline.set(`${prefix}:${key}`, value, { ex: TTL_SECONDS });
    await pipeline.exec();
    if (work.final) {
      // 最终返回前再次核验；缓存写成功不等于当前仍可公开。
      if (!await unchanged(corpus)) return pending(0, plan.total, "sources");
      return withAntiScrapeHeaders(new NextResponse(renderAnalysis(corpus, validateNote(raw, corpus.chunks)), {
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Persona-Tier": "public" },
      }));
    }
    return pending(plan.completed, plan.total, work.phase);
  } finally {
    await redis.eval(RELEASE, [lockKey], [lockToken]).catch(() => {});
  }
}
