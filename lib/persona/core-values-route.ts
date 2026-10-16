import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { getAnalysisDiaries } from "@/lib/notion";
import { withAntiScrapeHeaders } from "@/lib/request-guard";
import { streamChat } from "@/lib/persona/llm";
import {
  VALUES_VERSION, isProviderRefusal, makeValuesCorpus, parseJson, planValues, renderValues, validateValuesExtraction,
  validateValuesSynthesis, valuesPrompt, type ValuesCorpus, type ValuesWork, type ValuesChunk,
} from "@/lib/persona/core-values";

/**
 * 「核心价值观」的路由层。骨架与 first-principles-route.ts 同形（每请求一次模型调用、
 * 逐批落盘、跨实例锁、拒答二分收敛），这是本仓库当前刻意的重复：把骨架抽成公共管线要动
 * 已上线的那个 skill，先不做。改这里的任何并发或缓存逻辑时，务必同步检查那份实现。
 *
 * 与第一个 skill 的隔离点只有两处，其余不变式完全相同：命名空间带自己的版本号，
 * 以及规划/校验/提示词/渲染都来自 core-values.ts。命名空间一旦写错（例如共用前缀或
 * 共用版本号），两边的 chunk:/skip:/group:/report:/build-lock 键会互相污染，
 * 对方会把本 skill 的进度当成自己的：报告引用一段原文、同时声明该段未纳入。
 */
const TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * 输出预算与条数上限是配套的一档。最终报告最多 FINAL_MAX=8 条，每条满字段
 * （claim 220 + boundary 220 + 3 条证据的引文与 key）约 1.06 万字符；
 * 中文按最保守的 0.6 token/字符折算已越过 6144，strict 模式下会被供应商截断，
 * 再由 llm.ts 抛成「模型未完整返回分析结果」，而这条错误不被 isProviderRefusal 认领，
 * 于是整批硬失败、不写进度，每次点击白烧一次额度。最终层因此单给一档预算。
 */
const MAX_OUTPUT_TOKENS = 6_144;
const FINAL_OUTPUT_TOKENS = 8_192;
const RELEASE = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

function json(body: unknown, status: number) {
  return withAntiScrapeHeaders(NextResponse.json(body, { status }));
}
function pending(completed: number, total: number, phase: "sources" | "extract" | "synthesize") {
  return json({ status: "processing", phase, completed, total, retryAfterMs: 9_000 }, 202);
}
function namespace(): string {
  const environment = process.env.VERCEL_ENV || (process.env.NODE_ENV === "production" ? "production" : "local");
  return `dr:blog:core-values:${VALUES_VERSION}:${environment}`;
}
async function unchanged(corpus: ValuesCorpus): Promise<boolean> {
  const latest = await getAnalysisDiaries();
  return latest !== null && makeValuesCorpus(latest).hash === corpus.hash;
}

/** 一个请求最多一次模型调用，逐批持久化。任何访客均只分析公开博客，与人设记忆隔离。 */
export async function runCoreValues(req: Request, authorizeModel: () => Promise<Response | null>): Promise<Response> {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return json({ error: "文章分析暂时不可用，请稍后再试。" }, 503);
  const redis = new Redis({ url, token });
  const prefix = namespace();
  const diaries = await getAnalysisDiaries();
  if (diaries === null) return pending(0, 0, "sources");
  const corpus = makeValuesCorpus(diaries);
  if (!corpus.articles.length) return json({ error: "暂时没有可分析的公开文章。" }, 422);
  const read = async (keys: string[]) => {
    const values: unknown[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      values.push(...await redis.mget(...keys.slice(i, i + 100).map((k) => `${prefix}:${k}`)));
    }
    return values;
  };
  const plan = await planValues(corpus, read);
  if (plan.result) {
    if (!await unchanged(corpus)) return pending(0, corpus.articles.length, "sources");
    return withAntiScrapeHeaders(new NextResponse(renderValues(corpus, plan.result, plan.exclusions), {
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
    const lockedPlan = await planValues(corpus, read);
    if (lockedPlan.result) return pending(lockedPlan.completed, lockedPlan.total, "synthesize");
    work = lockedPlan.work!;
    const rejected = await authorizeModel();
    if (rejected) return rejected;
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]);
    /** 真的跑一次模型。拒答、网络、超时都原样抛出，由调用方分辨是不是内容策略拒答。 */
    const runModel = async (item: ValuesWork): Promise<string> => {
      const stream = await streamChat({ system: valuesPrompt(item),
        messages: [{ role: "user", content: item.input }], maxTokens: item.final ? FINAL_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
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
      return text;
    };
    /**
     * 供应商内容策略拒答的爆炸半径：`pack` 按正文顺序切分、可跨文章，一个提炼批次最多
     * MAX_BATCH_CHUNKS=12 个切块，所以「整批标记」最坏一次把 12 个切块（跨最多 12 篇文章）
     * 写成未纳入，报告结尾就会写「另有 12 篇…未纳入」，与只有一篇真正触发的事实差一个数量级。
     * 因此改成二分收敛：只标记真正被拒的那一个切块，最坏 1 篇，7 天 TTL 也只锁住它。
     * 代价要如实记在这里：收敛过程每次探测都是真实模型调用（计全站分析额度），
     * 12 块二分深度 ≤4，每层最多探两半，故额外调用上界 8 次、含原始失败一次共 9 次；
     * 被拒块若总在探测顺序的前半，实际约 4~6 次。探测成功那一半的结果不落盘（只用它排除嫌疑）。
     * 两处 catch 都要走这里：拒答既可能在建立连接时抛出，也可能在读流期间才由 SSE 内错误
     * 或 strict 截断抛出。只包住 streamChat 会让流内拒答无标记可写，每次点击白烧一次额度，
     * 进度却永远不动。
     */
    const BISECT_CALL_BUDGET = 8;
    const locateRefused = async (chunks: ValuesChunk[], budget: { left: number }): Promise<ValuesChunk[]> => {
      // 只剩一块仍被拒：就是它（也可能是唯一一块的批次，整批即单块）
      if (chunks.length <= 1) return chunks;
      const mid = Math.ceil(chunks.length / 2);
      for (const half of [chunks.slice(0, mid), chunks.slice(mid)]) {
        // 预算耗尽：不猜。宁可这次请求失败，也不写一条错误的排除声明。
        if (budget.left <= 0) return [];
        budget.left--;
        try {
          await runModel({ key: work.key, phase: "extract", chunks: half, input: JSON.stringify(half), final: false });
        } catch (e) {
          if (isProviderRefusal(e)) return locateRefused(half, budget);
          // 网络、超时、额度等非拒答失败：不标记任何切块，按原样抛给调用方
          throw e;
        }
      }
      // 两半单独都能过：拒答不归因于某个切块（整批组合或偶发），不猜也不标记
      return [];
    };
    const skipRefusedBatch = async (e: unknown): Promise<Response | null> => {
      if (work.phase !== "extract" || !work.chunks?.length || !isProviderRefusal(e)) return null;
      const refused = await locateRefused(work.chunks, { left: BISECT_CALL_BUDGET });
      if (!refused.length) return null;
      const marks = redis.pipeline();
      for (const c of refused) {
        marks.set(`${prefix}:skip:${c.key}`, { reason: "provider-refusal", at: Date.now() }, { ex: TTL_SECONDS });
      }
      await marks.exec();
      console.warn(`[core-values] 供应商拒绝 ${refused.length} 个切块（原批次 ${work.chunks.length} 块），已标记跳过`);
      return pending(plan.completed, plan.total, work.phase);
    };
    let text: string;
    try {
      text = await runModel(work);
    } catch (e) {
      const refused = await skipRefusedBatch(e);
      if (refused) return refused;
      throw e;
    }
    signal.throwIfAborted();
    const raw = parseJson(text);
    // 综合路径无论是不是最终层都要校验并落盘：只给最终层校验时，中间层把 null 写进缓存，
    // 读回来仍是 null，同一组会被无限重算（第一个 skill 实测空转 60 次不出结果）。
    const synthesized = work.phase === "synthesize" ? validateValuesSynthesis(raw, work, corpus) : null;
    const entries = work.phase === "extract"
      ? [...validateValuesExtraction(raw, work.chunks!)].map(([key, value]) => [`chunk:${key}`, value] as const)
      : ([[work.key, synthesized!]] as const);
    // 生成期间改文、删除或转私密：不发布旧报告，也不继续写入旧依据。
    if (!await unchanged(corpus)) return pending(0, plan.total, "sources");
    const pipeline = redis.pipeline();
    for (const [key, value] of entries) pipeline.set(`${prefix}:${key}`, value, { ex: TTL_SECONDS });
    await pipeline.exec();
    if (work.final) {
      // 最终返回前再次核验；缓存写成功不等于当前仍可公开。
      if (!await unchanged(corpus)) return pending(0, plan.total, "sources");
      return withAntiScrapeHeaders(new NextResponse(renderValues(corpus, synthesized!, lockedPlan.exclusions), {
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Persona-Tier": "public" },
      }));
    }
    return pending(plan.completed, plan.total, work.phase);
  } finally {
    await redis.eval(RELEASE, [lockKey], [lockToken]).catch(() => {});
  }
}
