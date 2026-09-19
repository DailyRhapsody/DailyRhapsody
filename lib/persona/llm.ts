/**
 * 数字人对话的模型适配层，只做流式文本。
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
  constructor(message: string, readonly status: number) {
    super(message);
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

type DeltaPicker = (data: unknown) => { text?: string; error?: string; truncated?: boolean };

/** 触到输出上限时补在末尾，免得半句话看起来像完整回答 */
const TRUNCATED_NOTE = "\n\n……篇幅有限，先说到这里。";

const pickOpenAi: DeltaPicker = (data) => {
  const d = data as {
    choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
    error?: { message?: string };
  };
  if (d.error) return { error: d.error.message || "upstream error" };
  const choice = d.choices?.[0];
  // 推理类模型额外返回 reasoning_content，只取 content，不把思考过程吐给访客
  return { text: choice?.delta?.content, truncated: choice?.finish_reason === "length" };
};

const pickAnthropic: DeltaPicker = (data) => {
  const d = data as {
    type?: string;
    delta?: { type?: string; text?: string; stop_reason?: string };
    error?: { message?: string };
  };
  if (d.type === "error") return { error: d.error?.message || "upstream error" };
  if (d.type === "content_block_delta" && d.delta?.type === "text_delta") return { text: d.delta.text };
  if (d.type === "message_delta") return { truncated: d.delta?.stop_reason === "max_tokens" };
  return {};
};

/** 把上游 SSE 转成纯文本流；上游中途报错时让流以错误结束，前端据此提示中断 */
function sseToText(pick: DeltaPicker): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  let truncated = false;
  const handle = (line: string, ctrl: TransformStreamDefaultController<Uint8Array>) => {
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
    const { text, error, truncated: cut } = pick(parsed);
    if (cut) truncated = true;
    if (error) ctrl.error(new LlmError(error, 502));
    else if (text) ctrl.enqueue(enc.encode(text));
  };
  return new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) handle(l, ctrl);
    },
    flush(ctrl) {
      if (buf) handle(buf, ctrl);
      if (truncated) ctrl.enqueue(enc.encode(TRUNCATED_NOTE));
    },
  });
}

async function upstreamError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string };
    const msg = typeof j.error === "string" ? j.error : j.error?.message;
    if (msg) return msg.slice(0, 240);
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
  return res.body.pipeThrough(sseToText(cfg.protocol === "anthropic" ? pickAnthropic : pickOpenAi));
}
