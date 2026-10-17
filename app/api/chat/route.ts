import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import { getCachedDiaries } from "@/lib/notion";
import { runAgentChat } from "@/lib/persona/agent-loop";
import { AGENT_LIMITS, CHAT_LIMITS, getAgentMode, getPetMode } from "@/lib/persona/config";
import { skillRunner } from "@/lib/persona/skill-runners";
import { findSkill } from "@/lib/persona/skills";
import { isLlmConfigured, LlmError, streamChat, supportsToolCalls, type LlmMessage } from "@/lib/persona/llm";
import { buildBlogFacts } from "@/lib/persona/facts";
import { buildSystemPrompt } from "@/lib/persona/prompt";
import { retrieveSnippets } from "@/lib/persona/retrieve";
import { stripInvisible } from "@/lib/persona/tools";
import { loadPersona } from "@/lib/persona/store";
import type { PersonaTier } from "@/lib/persona/types";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";
import { isUpstashConfigured, limitByIp } from "@/lib/upstash-rate-limit";

// 分析（Skill）每次只调用一次模型；300s 同时为文章缓存的后台刷新保留原有预算。
// Agent 模式下普通对话改走工具循环（模型调用 ≤5 次 / 工具执行 ≤4 次，预算见 AGENT_LIMITS），Skill 口径不受影响。
export const maxDuration = 300;

/** 检索只看最后一句提问的末尾，检索开销与消息长度无关 */
const QUERY_TAIL_CHARS = 500;

function json(body: unknown, status: number) {
  return withAntiScrapeHeaders(NextResponse.json(body, { status }));
}

/**
 * 按开关与身份决定本次请求能否对话；null 表示不开放。
 * 身份只决定「优先尝试 owner 包」，真正用哪一级由加载到的包决定：
 * owner 包只存在于本机开发环境，线上管理员拿到的也是 public 包。
 */
async function resolveAccess(): Promise<{ admin: boolean } | null> {
  const mode = getPetMode();
  if (mode === "off") return null;
  const admin = await isAdmin();
  if (admin) return { admin };
  return mode === "public" ? { admin } : null;
}

/** 面板打开时查询是否可用，并取开场建议问题 */
export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, { scope: "chat:status", limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const access = await resolveAccess();
  if (!access) return json({ error: "Not found" }, 404);
  const bundle = await loadPersona(access.admin);
  const tier: PersonaTier = bundle?.tier ?? "public";
  return json({ ready: isLlmConfigured() && !!bundle, tier, starters: bundle?.starters ?? [] }, 200);
}

function normalizeMessages(raw: unknown): LlmMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const msgs: LlmMessage[] = [];
  for (const m of raw.slice(-CHAT_LIMITS.maxTurns)) {
    if (!m || typeof m !== "object") continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const cap = role === "user" ? CHAT_LIMITS.maxUserChars : CHAT_LIMITS.maxAssistantChars;
    // 隐形字符（Unicode Tag 区、零宽字符）是注入走私的常见载体，进上下文前先清洗
    const text = (role === "user" ? stripInvisible(content) : content).trim().slice(0, cap);
    if (!text) continue;
    // 同角色连续出现时合并，保证 user/assistant 交替（Anthropic 协议强制要求）
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === role) prev.content = `${prev.content}\n\n${text}`;
    else msgs.push({ role, content: text });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}


async function authorizeModel(req: Request, admin: boolean, analysis = false): Promise<Response | null> {
  // Skill 使用共享结果、固定服务器任务；每个真实批次计全站分析额度，不消耗聊天30轮。
  if (analysis) {
    try {
      return await limitByIp("chat:analysis:global", "all", 120, "1 d", { failClosed: true })
        ? null : json({ error: "今天的文章分析额度已用完，进度已保存，请明天继续。" }, 429);
    } catch {
      return json({ error: "文章分析暂时不可用。" }, 503);
    }
  }
  if (!admin) {
    // 花钱的接口：没有 Redis 时 limitByIp 会直接放行，生产环境宁可拒绝
    if (!isUpstashConfigured() && process.env.NODE_ENV === "production") {
      return json({ error: "暂时无法对话。" }, 503);
    }
    const ip = getClientIpFromRequest(req);
    try {
      // 日额度超限不记违规：正常聊多了的读者不该被全站封 IP
      if (!(await limitByIp("chat:daily", ip, CHAT_LIMITS.dailyPerIp, "1 d", { failClosed: true }))) {
        return json({ error: "今天聊得够多了，明天再来吧。" }, 429);
      }
      if (!(await limitByIp("chat:global", "all", CHAT_LIMITS.dailyGlobal, "1 d", { failClosed: true }))) {
        return json({ error: "今天的对话额度用完了，明天再来吧。" }, 503);
      }
    } catch (e) {
      console.error("[chat] quota", e);
      return json({ error: "暂时无法对话。" }, 503);
    }
  }

  return null;
}

export async function POST(req: Request) {
  const badOrigin = rejectCrossSiteWrite(req);
  if (badOrigin) return badOrigin;
  const blocked = await guardApiRequest(req, {
    scope: "chat:burst",
    limit: CHAT_LIMITS.burstPerMinute,
    windowMs: 60_000,
    blockSuspicious: false,
    // 读者连点「发送」「重试」撞上每分钟上限属于正常行为，不累计违规、不封 IP
    recordRateLimitViolation: false,
  });
  if (blocked) return blocked;

  const access = await resolveAccess();
  if (!access) return json({ error: "Not found" }, 404);

  // 按实际字节数判断：分块传输不带 Content-Length，只看请求头会被绕过
  const raw = await req.text().catch(() => "");
  if (Buffer.byteLength(raw) > CHAT_LIMITS.maxBodyBytes) return json({ error: "Payload too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid body" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "Invalid body" }, 400);
  // Skill 走同一条通道：目录负责校验与对外文案，runner 表负责执行与错误映射。
  // 这里不认识任何一个具体 skill，新增 skill 不需要改本文件。
  const rawSkill = (body as { skill?: unknown }).skill;
  const skill = rawSkill === undefined ? null : findSkill(rawSkill);
  if (rawSkill !== undefined && !skill) return json({ error: "未知 Skill" }, 400);
  if (skill) {
    if (!isLlmConfigured()) return json({ error: "数字人还没接上模型，稍后再来。" }, 503);
    const runner = skillRunner(skill.id);
    try {
      return await runner.run({
        req,
        authorize: () => authorizeModel(req, access.admin, skill.quota === "analysis"),
      });
    } catch (e) {
      if (req.signal.aborted) return new NextResponse(null, { status: 499 });
      // 各 skill 认领自己的异常；认不出来才落到通用文案
      const failure = runner.failure?.(e);
      if (failure) return json({ error: failure.error }, failure.status);
      // 带上 message：只记 name 时线上看不到「findings 6 条超过上限 3」这类真正的原因
      console.error("[chat] skill", skill.id, e instanceof Error ? `${e.name}: ${e.message}` : "error");
      return json({ error: skill.failure }, 502);
    }
  }
  const messages = normalizeMessages((body as { messages?: unknown }).messages);
  if (!messages) return json({ error: "消息不能为空" }, 400);

  if (!isLlmConfigured()) return json({ error: "数字人还没接上模型，稍后再来。" }, 503);
  const bundle = await loadPersona(access.admin);
  if (!bundle) return json({ error: "数字人还在准备中，稍后再来。" }, 503);
  const tier = bundle.tier;

  const quota = await authorizeModel(req, access.admin);
  if (quota) return quota;

  // 只读缓存、不触发 Notion 冷拉；缓存缺席时不带原文片段照常回答。
  // 每轮都读：Notion 里刚转私密或删除的文章要立即从检索里消失，与其他接口一致
  const diaries = (await getCachedDiaries()) ?? [];
  // 访客：只检索公开文章，并排除回避主题（按标签与逐篇清单；文章照常公开，AI-Persona 不引用）
  const avoidTags = new Set(bundle.avoidTags);
  const avoidIds = new Set(bundle.avoidIds);
  const visible =
    tier === "owner"
      ? diaries
      : diaries.filter(
          (d) => d.isPublic !== false && !avoidIds.has(d.id) && !d.tags?.some((t) => avoidTags.has(t)),
        );
  const lastQuestion = messages[messages.length - 1].content;
  const snippets = retrieveSnippets(lastQuestion.slice(-QUERY_TAIL_CHARS), visible, bundle.notes);
  // 篇数按页面同口径统计（访客只算公开文章）；回避主题只从「最近几篇」「常用标签」里隐去
  const counted = tier === "owner" ? diaries : diaries.filter((d) => d.isPublic !== false);
  const facts = buildBlogFacts(
    counted,
    tier === "owner" ? { tags: new Set(), ids: new Set() } : { tags: avoidTags, ids: avoidIds },
    tier === "owner" ? diaries.filter((d) => d.isPublic === false).length : 0,
  );

  const agentMode = getAgentMode();
  const agentOn = (agentMode === "on" || (agentMode === "owner" && access.admin)) && supportsToolCalls();
  if (agentOn) {
    // agent 循环：首步过费用闸（从第二步起循环内逐次复查）；之后是 NDJSON 事件流
    let allowed = false;
    try {
      allowed = await limitByIp("chat:agent:steps", "all", AGENT_LIMITS.siteDailySteps, "1 d", { failClosed: true });
    } catch {
      allowed = false;
    }
    if (!allowed) return json({ error: "今天的对话额度用完了，明天再来吧。" }, 503);
    const stream = runAgentChat({
      system: buildSystemPrompt(bundle, snippets, tier, facts, { agent: true }),
      history: messages,
      ctx: { diaries: visible, notes: bundle.notes, facts },
      maxTokens: tier === "owner" ? CHAT_LIMITS.maxOutputTokensOwner : CHAT_LIMITS.maxOutputTokensPublic,
      signal: req.signal,
    });
    const res = new NextResponse(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Persona-Tier": tier,
        // 关掉代理层缓冲，保证事件逐条到达
        "X-Accel-Buffering": "no",
      },
    });
    return withAntiScrapeHeaders(res);
  }

  try {
    const stream = await streamChat({
      system: buildSystemPrompt(bundle, snippets, tier, facts),
      messages,
      maxTokens: tier === "owner" ? CHAT_LIMITS.maxOutputTokensOwner : CHAT_LIMITS.maxOutputTokensPublic,
      // 访客关页即中止上游，停止计费
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(CHAT_LIMITS.upstreamTimeoutMs)]),
    });
    const res = new NextResponse(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Persona-Tier": tier,
        // 关掉代理层缓冲，保证逐字到达
        "X-Accel-Buffering": "no",
      },
    });
    return withAntiScrapeHeaders(res);
  } catch (e) {
    // 访客已停止或关页：没有人在等这个响应，不记日志
    if (req.signal.aborted) return new NextResponse(null, { status: 499 });
    if (e instanceof LlmError) {
      console.error("[chat] upstream", e.status, e.message);
      return json({ error: e.status === 503 ? "数字人还没接上模型。" : "模型暂时没有响应，请稍后再试。" }, e.status);
    }
    if ((e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError") {
      return json({ error: "请求超时，请稍后再试。" }, 504);
    }
    console.error("[chat] unexpected", e);
    return json({ error: "出错了，请稍后再试。" }, 500);
  }
}
