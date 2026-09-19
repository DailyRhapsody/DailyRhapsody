import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import { getCachedDiaries } from "@/lib/notion";
import { CHAT_LIMITS, getPetMode } from "@/lib/persona/config";
import { isLlmConfigured, LlmError, streamChat, type LlmMessage } from "@/lib/persona/llm";
import { buildSystemPrompt } from "@/lib/persona/prompt";
import { retrieveSnippets } from "@/lib/persona/retrieve";
import { loadPersona } from "@/lib/persona/store";
import type { PersonaTier } from "@/lib/persona/types";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";
import { isUpstashConfigured, limitByIp } from "@/lib/upstash-rate-limit";

// 流式响应的时长计入函数时长；上游超时设在 55s，这里留出余量
export const maxDuration = 60;

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
    const text = content.trim().slice(0, cap);
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
  const messages = normalizeMessages((body as { messages?: unknown }).messages);
  if (!messages) return json({ error: "消息不能为空" }, 400);

  if (!isLlmConfigured()) return json({ error: "数字人还没接上模型，稍后再来。" }, 503);
  const bundle = await loadPersona(access.admin);
  if (!bundle) return json({ error: "数字人还在准备中，稍后再来。" }, 503);
  const tier = bundle.tier;

  // 额度放在所有校验之后：无效请求、人设未就绪都不消耗额度
  if (!access.admin) {
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

  // 只读缓存、不触发 Notion 冷拉；缓存缺席时不带原文片段照常回答。
  // 每轮都读：Notion 里刚转私密或删除的文章要立即从检索里消失，与其他接口一致
  const diaries = (await getCachedDiaries()) ?? [];
  // 访客：只检索公开文章，并排除回避主题（按标签与逐篇清单；文章照常公开，数字人不引用）
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

  try {
    const stream = await streamChat({
      system: buildSystemPrompt(bundle, snippets, tier),
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
