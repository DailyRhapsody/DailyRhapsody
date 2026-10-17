/**
 * AI-Persona 对话的模型适配层，只做流式文本。
 *
 * 两种协议覆盖绝大多数供应商：
 * - openai（默认）：/chat/completions，DeepSeek、Kimi、通义、OpenRouter 等兼容服务都走这条
 * - anthropic：/v1/messages
 *
 * 未单独配置时沿用后台编辑器那组 OPENAI_* / AI_MODEL，只配一次也能跑。
 */

export type LlmMessage = { role: "user" | "assistant"; content: string };

/** agent 循环用的工具协议类型（仅 openai 分支实现） */
export type LlmToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type LlmToolCall = { id: string; name: string; arguments: string };

/**
 * 工具循环的消息形状：在纯文本消息之外，支持「带 tool_calls 的 assistant 轮」
 * 与「role=tool 的结果回填轮」。普通聊天的历史消息形状不变。
 */
export type LlmStepMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** 一次模型调用的结构化事件流（agent 循环消费） */
export type ToolStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: LlmToolCall[] }
  | { type: "done" }
  | { type: "error"; message: string };

type Protocol = "openai" | "anthropic";

export class LlmError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getConfig() {
  const protocol: Protocol =
    process.env.PERSONA_LLM_PROTOCOL?.trim().toLowerCase() === "anthropic" ? "anthropic" : "openai";
  const shared = protocol === "openai";
  const apiKey =
    process.env.PERSONA_LLM_API_KEY?.trim() || (shared ? process.env.OPENAI_API_KEY?.trim() : "") || "";
  const model =
    process.env.PERSONA_LLM_MODEL?.trim() || (shared ? process.env.AI_MODEL?.trim() : "") || "";
  const baseDefault =
    protocol === "anthropic"
      ? "https://api.anthropic.com"
      : process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const base = (process.env.PERSONA_LLM_BASE_URL?.trim() || baseDefault).replace(/\/+$/, "");
  return { protocol, apiKey, model, base };
}

export function isLlmConfigured(): boolean {
  const c = getConfig();
  return !!(c.apiKey && c.model);
}

/** agent 循环需要 openai 协议（工具协议只实现了这条分支）；配置切协议时调用方据此降级单步直答 */
export function supportsToolCalls(): boolean {
  return getConfig().protocol === "openai";
}

type DeltaPicker = (data: unknown) => { text?: string; error?: string; truncated?: boolean; complete?: boolean };

/** 触到输出上限时补在末尾，免得半句话看起来像完整回答 */
const TRUNCATED_NOTE = "\n\n……篇幅有限，先说到这里。";

/**
 * 供应商拒答的 finish_reason：OpenAI/Azure 用 content_filter，部分国内供应商用 sensitive。
 * 这类响应没有 error 行、只有 finish_reason，必须在这里转成可识别的错误，否则 strict 模式
 * 会把它并进通用文案「模型未完整返回分析结果」，isProviderRefusal 认不出来，上层只能永久重试。
 * 括号里的 content_filter 是这一族错误的通用关键词（isProviderRefusal 据此识别，切换供应商
 * 时不用改这里），冒号后才是供应商实际给的原因。
 */
const REFUSAL_FINISH_REASONS = new Set(["content_filter", "sensitive", "content_filtered"]);
const refusalError = (reason: string) => `供应商内容策略拒绝（content_filter）：finish_reason=${reason}`;

/** 上游错误体：message 之外还要带上 code/type——Azure 拒答常常 message 干净、只有 code=content_filter。 */
function describeUpstreamError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 240);
  if (!error || typeof error !== "object") return "upstream error";
  const e = error as { message?: unknown; code?: unknown; type?: unknown };
  const marks = [e.code, e.type].filter((v): v is string => typeof v === "string" && !!v.trim());
  const message = typeof e.message === "string" ? e.message.trim() : "";
  return ([marks.join("/"), message].filter(Boolean).join(": ") || "upstream error").slice(0, 240);
}

/** 拒答只认 finish_reason/refusal 字段，不认「模型自己说不方便回答」的正文，避免把正常内容当拒答。 */
function refusalReason(choice: { finish_reason?: string | null; delta?: { refusal?: string | null } } | undefined): string | null {
  const finish = choice?.finish_reason;
  if (typeof finish === "string" && REFUSAL_FINISH_REASONS.has(finish)) return finish;
  if (typeof choice?.delta?.refusal === "string" && choice.delta.refusal.trim()) return "refusal";
  return null;
}

const pickOpenAi: DeltaPicker = (data) => {
  const d = data as {
    choices?: { delta?: { content?: string; refusal?: string | null }; finish_reason?: string | null }[];
    error?: unknown;
  };
  if (d.error) return { error: describeUpstreamError(d.error) };
  const choice = d.choices?.[0];
  const refused = refusalReason(choice);
  if (refused) return { error: refusalError(refused) };
  // 推理类模型额外返回 reasoning_content，只取 content，不把思考过程吐给访客
  return { text: choice?.delta?.content, truncated: choice?.finish_reason === "length", complete: choice?.finish_reason === "stop" };
};

const pickAnthropic: DeltaPicker = (data) => {
  const d = data as {
    type?: string;
    delta?: { type?: string; text?: string; stop_reason?: string };
    error?: unknown;
  };
  if (d.type === "error") return { error: describeUpstreamError(d.error) };
  if (d.type === "content_block_delta" && d.delta?.type === "text_delta") return { text: d.delta.text };
  if (d.type === "message_delta") {
    // Anthropic 的拒答以 stop_reason=refusal 收尾，同样不给 error 行
    if (d.delta?.stop_reason === "refusal") return { error: refusalError("refusal") };
    return { truncated: d.delta?.stop_reason === "max_tokens", complete: d.delta?.stop_reason === "end_turn" };
  }
  return {};
};

/** 把上游 SSE 转成纯文本流；上游中途报错时让流以错误结束，前端据此提示中断 */
function sseToText(pick: DeltaPicker, strict = false): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  let truncated = false;
  let complete = false;
  let failed = false;
  const handle = (line: string, ctrl: TransformStreamDefaultController<Uint8Array>) => {
    if (failed) return;
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const { text, error, truncated: cut, complete: ended } = pick(parsed);
    if (cut) truncated = true;
    if (ended) complete = true;
    if (error) {
      failed = true;
      ctrl.error(new LlmError(error, 502));
    } else if (text) ctrl.enqueue(enc.encode(text));
  };
  return new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) handle(l, ctrl);
    },
    flush(ctrl) {
      if (failed) return;
      buf += dec.decode();
      if (buf) handle(buf, ctrl);
      if (failed) return;
      if (strict && (truncated || !complete)) {
        ctrl.error(new LlmError("模型未完整返回分析结果", 502));
        return;
      }
      if (truncated) ctrl.enqueue(enc.encode(TRUNCATED_NOTE));
    },
  });
}

async function upstreamError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw) as { error?: unknown };
    if (j.error !== undefined) {
      const described = describeUpstreamError(j.error);
      if (described !== "upstream error") return described;
    }
  } catch {
    /* 非 JSON 错误体 */
  }
  return raw.slice(0, 240) || `HTTP ${res.status}`;
}

export async function streamChat(opts: {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  /** 结构化分析必须等到协议明确正常结束，截断/断流不可提交。 */
  strict?: boolean;
}): Promise<ReadableStream<Uint8Array>> {
  const cfg = getConfig();
  if (!cfg.apiKey || !cfg.model) throw new LlmError("对话模型未配置", 503);
  const temperature = opts.temperature ?? 0.7;

  let res: Response;
  if (cfg.protocol === "anthropic") {
    const url = /\/v1$/.test(cfg.base) ? `${cfg.base}/messages` : `${cfg.base}/v1/messages`;
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        system: opts.system,
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        temperature,
        stream: true,
      }),
      signal: opts.signal,
    });
  } else {
    res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: opts.system }, ...opts.messages],
        max_tokens: opts.maxTokens,
        temperature,
        stream: true,
      }),
      signal: opts.signal,
    });
  }

  if (!res.ok || !res.body) {
    throw new LlmError(await upstreamError(res), 502);
  }
  return res.body.pipeThrough(sseToText(cfg.protocol === "anthropic" ? pickAnthropic : pickOpenAi, opts.strict));
}

/**
 * 工具循环的单步调用（仅 openai 协议）。与 streamChat 的区别：
 * 事件流里多出 tool_calls（按 index 聚合分片参数），不做 strict 收尾判定——
 * 循环怎么继续由调用方按事件类型决定。
 *
 * DeepSeek V4 默认开 thinking：关闭它才不需要按文档回传 reasoning_content，
 * 也省掉一半输出 token；其他供应商不认识这个字段，只在 deepseek 域名下发。
 */
export async function streamChatTools(opts: {
  system: string;
  messages: LlmStepMessage[];
  tools: LlmToolDef[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  /** 收尾轮：仍带工具目录（模型据此知道自己查过什么），但 tool_choice=none 禁止再调用 */
  noMoreTools?: boolean;
}): Promise<ReadableStream<ToolStreamEvent>> {
  const cfg = getConfig();
  if (!cfg.apiKey || !cfg.model) throw new LlmError("对话模型未配置", 503);
  if (cfg.protocol !== "openai") {
    // 工具协议只实现了 openai 分支；配置切到 anthropic 时由调用方降级回单步直答
    throw new LlmError("当前协议不支持工具调用", 503);
  }
  // 线上报文形状：OpenAI 系的 tool_calls 每项必须带 type:"function" 与 function 包裹；
  // 内部扁平形状（id/name/arguments）直接发出去会被 DeepSeek 400 拒绝
  //（实测 messages[i]: missing field `type`）。历史里的 assistant 轮在这里转换，内部类型不动。
  const wire = opts.messages.map((m) =>
    m.role === "assistant" && "tool_calls" in m && m.tool_calls
      ? {
          role: "assistant",
          content: m.content,
          tool_calls: m.tool_calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : m,
  );
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: "system", content: opts.system }, ...wire],
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0.7,
    stream: true,
    tools: opts.tools,
    tool_choice: opts.noMoreTools ? "none" : "auto",
  };
  if (/deepseek/i.test(cfg.base)) body.thinking = { type: "disabled" };
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new LlmError(await upstreamError(res), 502);
  }
  return res.body.pipeThrough(stepEventStream());
}

/** SSE → 结构化事件：文本即时转发；tool_calls 按 index 聚合、流末尾一次性发出 */
function stepEventStream(): TransformStream<Uint8Array, ToolStreamEvent> {
  const dec = new TextDecoder();
  let buf = "";
  let failed = false;
  let truncated = false;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  // 缺 index 的方言（部分兼容网关）：按「出现顺序 + id 变化」兜底分槽。
  // 旧的统一落 0 号槽会把两条独立调用静默并成一条（对抗复核实测）。
  let autoSlot = -1;
  let autoId: string | null = null;
  const resolveIdx = (tc: { index?: number; id?: string }): number => {
    if (typeof tc.index === "number") return tc.index;
    if (tc.id) {
      if (autoId !== tc.id) {
        autoSlot += 1;
        autoId = tc.id;
      }
      return autoSlot;
    }
    if (autoSlot < 0) autoSlot = 0;
    return autoSlot;
  };
  const handle = (line: string, ctrl: TransformStreamDefaultController<ToolStreamEvent>) => {
    if (failed) return;
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let parsed: {
      error?: unknown;
      choices?: {
        finish_reason?: string | null;
        delta?: {
          content?: string;
          refusal?: string | null;
          tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed.error !== undefined) {
      failed = true;
      ctrl.enqueue({ type: "error", message: describeUpstreamError(parsed.error) });
      return;
    }
    const choice = parsed.choices?.[0];
    if (!choice) return;
    const refused = refusalReason(choice);
    if (refused) {
      failed = true;
      ctrl.enqueue({ type: "error", message: refusalError(refused) });
      return;
    }
    if (choice.finish_reason === "length") truncated = true;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      ctrl.enqueue({ type: "text", text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = resolveIdx(tc);
        const acc = calls.get(idx) ?? { id: "", name: "", arguments: "" };
        if (tc.id) acc.id = tc.id;
        // 仅当与已累计值不同才追加：分片拼接（search + _blog）正常，
        // 每片重发完整名字的方言不会拼成 search_blogsearch_blog
        if (tc.function?.name && tc.function.name !== acc.name) acc.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") acc.arguments += tc.function.arguments;
        calls.set(idx, acc);
      }
    }
  };
  return new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) handle(l, ctrl);
    },
    flush(ctrl) {
      // 多字节字符可能被切在分片中间：与 sseToText 对齐，先补一次尾部解码
      buf += dec.decode();
      if (!failed && buf) handle(buf, ctrl);
      if (failed) return;
      if (truncated) {
        // 触到输出上限：聚合中的工具调用参数可能被切半，一律丢弃不执行；
        // 以与普通路径相同的截断文案收尾（agent-loop 收到文本即按已作答处理）
        calls.clear();
        ctrl.enqueue({ type: "text", text: TRUNCATED_NOTE });
      }
      if (calls.size > 0) {
        const seen = new Set<string>();
        const list = [...calls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v], i) => {
            let id = v.id || `call_${i}`;
            // 上游显式给出重复 id 时保证批内唯一（同批 tool 消息回填不容重复 id）
            if (seen.has(id)) id = `${id}_${i}`;
            seen.add(id);
            return { id, name: v.name, arguments: v.arguments || "{}" };
          });
        ctrl.enqueue({ type: "tool_calls", calls: list });
      } else {
        ctrl.enqueue({ type: "done" });
      }
    },
  });
}
