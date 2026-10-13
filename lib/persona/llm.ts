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
