/**
 * 数字人的工具循环（agent 壳，v1 全部只读工具）。
 *
 * 预算三重闸（数值在 config.ts 的 AGENT_LIMITS）：
 * - 模型调用 ≤5 次：最后一轮 tool_choice=none 强制收尾作答，保证一定有回答；
 * - 工具执行 ≤4 次：同参数重复的调用不重复执行（停滞守卫，照 Hermes tool_guardrails 思路），
 *   返回提示让模型换路子或直接作答；
 * - 总时长 ≤150s、单步 ≤55s；且每次模型调用前过一道全站步数费用闸（Upstash，一次调用记一步）。
 *
 * 输出为 NDJSON 事件流（首包即达；前端把「进度」与「正文」分开渲染）：
 *   {"t":"step","label":"正在翻我的文章…"} / {"t":"delta","v":"…"} / {"t":"done"} / {"t":"error","msg":"…"}
 *
 * 失败策略：工具实现异常折成错误文本回填（不级联、不重试放大）；模型调用失败即报错收尾，
 * 已流出的文字保留（前端按既有「回复中断」逻辑处理）；对外文案不携带任何上游细节。
 */

import { AGENT_LIMITS } from "@/lib/persona/config";
import { streamChatTools, LlmError, type LlmStepMessage, type LlmToolCall, type LlmToolDef, type ToolStreamEvent } from "@/lib/persona/llm";
import { TOOL_DEFS, wrapUntrusted } from "@/lib/persona/tools";
import { runTool, type ToolContext } from "@/lib/persona/tool-runners";
import { limitByIp } from "@/lib/upstash-rate-limit";

const enc = new TextEncoder();

const FRIENDLY_ERROR = "模型暂时没有响应，请稍后再试。";
const FRIENDLY_TIMEOUT = "请求超时，请稍后再试。";

function friendly(e: unknown): string {
  if (e instanceof LlmError) return e.status === 503 ? "数字人还没接上模型。" : FRIENDLY_ERROR;
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return FRIENDLY_TIMEOUT;
  return FRIENDLY_ERROR;
}

/** 工具名 → schema 里声明的参数键白名单（签名前过滤多余键，镜像 tool-runners 的取参语义） */
const SCHEMA_KEYS: Record<string, string[]> = Object.fromEntries(
  TOOL_DEFS.map((t) => [
    t.function.name,
    Object.keys((t.function.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
  ]),
);

/**
 * 参数字符串的意图签名：先按 schema 白名单过滤键、字符串值 trim（与 tool-runners 的
 * argString 同语义），再按键排序重排（吃掉空格、换行与键序差异）；解析失败退回原串。
 * 只归一「执行结果必然相同」的差异，避免两个真实不同的调用被误判为重复。
 */
function argsSignature(name: string, raw: string): string {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const allowed = SCHEMA_KEYS[name];
    let v = parsed;
    if (allowed && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const picked: Record<string, unknown> = {};
      for (const k of allowed) {
        if (k in (parsed as Record<string, unknown>)) picked[k] = (parsed as Record<string, unknown>)[k];
      }
      v = picked;
    }
    return stableStringify(v);
  } catch {
    return raw;
  }
}

function stableStringify(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.trim());
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export type AgentChatOptions = {
  system: string;
  /** 访客历史（user/assistant 纯文本），来自路由层 normalizeMessages */
  history: { role: "user" | "assistant"; content: string }[];
  /** 工具数据源：路由层已过滤的可见集合与同口径统计 */
  ctx: ToolContext;
  maxTokens: number;
  signal: AbortSignal;
};

export function runAgentChat(opts: AgentChatOptions): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true; // 客户端已断开：后续写入静默丢弃
        }
      };
      const messages: LlmStepMessage[] = opts.history.map((m) => ({ role: m.role, content: m.content }));
      const executed = new Set<string>(); // 已执行过的 tool:args 签名（停滞守卫）
      let toolRuns = 0;
      let modelCalls = 0;
      let answered = false; // 是否已向客户端流出正文
      const deadline = Date.now() + AGENT_LIMITS.totalDeadlineMs;

      try {
        for (;;) {
          if (opts.signal.aborted || closed) break;
          if (modelCalls >= AGENT_LIMITS.maxModelCalls) break;
          // 费用闸：首步已在路由层预检过一次，这里从第二步起逐次复查
          if (modelCalls > 0) {
            let allowed = false;
            try {
              allowed = await limitByIp("chat:agent:steps", "all", AGENT_LIMITS.siteDailySteps, "1 d", { failClosed: true });
            } catch {
              allowed = false;
            }
            if (!allowed) {
              send({ t: "error", msg: "今天的对话额度用完了，明天再来吧。" });
              return;
            }
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            send(answered ? { t: "done" } : { t: "error", msg: FRIENDLY_TIMEOUT });
            return;
          }
          const finalRound =
            toolRuns >= AGENT_LIMITS.maxToolCalls || modelCalls === AGENT_LIMITS.maxModelCalls - 1;
          modelCalls += 1;
          const stepSignal = AbortSignal.any([
            opts.signal,
            AbortSignal.timeout(Math.min(AGENT_LIMITS.perStepTimeoutMs, remaining)),
          ]);

          let stream: ReadableStream<ToolStreamEvent>;
          try {
            stream = await streamChatTools({
              system: opts.system,
              messages,
              tools: TOOL_DEFS as unknown as LlmToolDef[],
              maxTokens: opts.maxTokens,
              signal: stepSignal,
              noMoreTools: finalRound,
            });
          } catch (e) {
            console.error("[chat] agent step", e instanceof Error ? `${e.name}: ${e.message}` : "error");
            // 上游失败一律发 error 收尾（已流出的文字由前端保留并给重试），不冒充完整回答
            send({ t: "error", msg: friendly(e) });
            return;
          }

          const calls: LlmToolCall[] = [];
          let stepText = "";
          let stepError: unknown = null;
          const reader = stream.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value.type === "text") {
                answered = true;
                stepText += value.text;
                send({ t: "delta", v: value.text });
              } else if (value.type === "tool_calls") {
                calls.push(...value.calls);
              } else if (value.type === "error") {
                stepError = new LlmError(value.message, 502);
                break;
              }
            }
          } catch (e) {
            stepError = e;
          }
          if (stepError !== null) {
            // 保留原始错误类型（超时/拒答文案走 friendly 分流），并统一按「回复中断」收尾
            console.error("[chat] agent stream", stepError instanceof Error ? `${stepError.name}: ${stepError.message}` : "error");
            send({ t: "error", msg: friendly(stepError) });
            return;
          }
          if (calls.length === 0) {
            // 模型直接作答（或收尾轮正常收束）：本轮文本已流出，结束
            send(answered ? { t: "done" } : { t: "error", msg: FRIENDLY_ERROR });
            return;
          }
          if (finalRound) {
            // 收尾轮仍返回工具调用（无视 tool_choice=none 的罕见情形）：不能再执行；
            // 旁白文字不算回答，按中断收尾，不给「看似完整」的假象
            send({ t: "error", msg: FRIENDLY_ERROR });
            return;
          }

          // 记录本轮 assistant 轮（带旁白文字与 tool_calls），逐个执行并回填
          messages.push({ role: "assistant", content: stepText || null, tool_calls: calls });
          for (const call of calls) {
            const sig = `${call.name}:${argsSignature(call.name, call.arguments)}`;
            let result: { label: string; content: string };
            let args: unknown = null;
            try {
              args = call.arguments ? JSON.parse(call.arguments) : {};
            } catch {
              args = null;
            }
            if (executed.has(sig)) {
              result = {
                label: "",
                content: wrapUntrusted(call.name, "（这条调用此前已经执行过，结果见上文。请直接基于已有资料作答，或换一个检索词。）"),
              };
            } else if (toolRuns >= AGENT_LIMITS.maxToolCalls) {
              result = {
                label: "",
                content: wrapUntrusted(call.name, "（工具调用已达上限，请直接基于已有资料作答。）"),
              };
            } else if (args === null) {
              result = {
                label: "",
                content: wrapUntrusted(call.name, "（参数不是合法 JSON，请修正后重试，或直接作答。）"),
              };
            } else {
              const ran = runTool(call.name, args, opts.ctx);
              if (ran) {
                result = ran;
                executed.add(sig);
                toolRuns += 1;
              } else {
                // 未登记的工具名：直接拒绝，绝不转发执行
                result = { label: "", content: wrapUntrusted(call.name, "（不存在这个工具。）") };
              }
            }
            if (result.label) send({ t: "step", label: result.label });
            messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
          }
        }
        // 循环自然走到头：模型调用次数用尽（模型一直在调工具）或客户端断开
        send(answered ? { t: "done" } : { t: "error", msg: FRIENDLY_ERROR });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  });
}
