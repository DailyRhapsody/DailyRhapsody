"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chatRequestBody } from "@/lib/persona/chat-request";
import { findSkill, type SkillId } from "@/lib/persona/skills";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

export type PetChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 回复中途断掉（网络、上游报错），保留已到达的部分并标记 */
  interrupted?: boolean;
  /** 这条消息由哪个 Skill 发起；续跑与重试要靠它还原请求 */
  skill?: SkillId;
};

const STORAGE_KEY = "dr_pet_chat_v1";
/** 首包等待：服务端上游超时 55s，默认的 30s 会先把慢模型砍掉 */
const FIRST_BYTE_TIMEOUT_MS = 65_000;
/** 流式期间落盘节流：整页跳转或刷新时，至少保住提问与已到达的半截回答 */
const STREAM_PERSIST_MS = 1_000;
const ANALYSIS_LIMIT_MS = 15 * 60_000;

function waitForAnalysis(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export type PetChatError = { message: string; retryable: boolean };

/** 服务端明确拒绝的（额度、未就绪、参数）重试也没用，不给「重试」按钮 */
function isRetryableStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 504;
}

class ChatHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** 流式中的那条回复落盘时标成中断：跳页后恢复出来能看出没说完，可以重试接上 */
function snapshotForStorage(list: PetChatMessage[], streaming: boolean): PetChatMessage[] {
  if (!streaming) return list;
  const last = list[list.length - 1];
  if (last?.role !== "assistant") return list;
  const head = list.slice(0, -1);
  return last.content ? [...head, { ...last, interrupted: true }] : head;
}

function loadStored(): PetChatMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    // 逐条校验而不是直接断言。历史里可能留着已下线 skill 的 id：断点提示会误触发，
    // 重试又固定撞 400「未知 Skill」，而 400 不在可重试状态里——访客拿不到重试入口。
    // role 一并校验：非法 role 会被当成助手消息渲染。
    return list.flatMap((m): PetChatMessage[] => {
      if (!m || typeof m !== "object") return [];
      const { id, role, content, interrupted, skill } = m as Record<string, unknown>;
      if (typeof id !== "string" || typeof content !== "string") return [];
      if (role !== "user" && role !== "assistant") return [];
      const known = findSkill(skill);
      return [{ id, role, content, ...(interrupted ? { interrupted: true } : {}),
        ...(known ? { skill: known.id } : {}) }];
    });
  } catch {
    return [];
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * AI-Persona 对话状态。对话只存在本标签页的 sessionStorage：站内链接整页跳转后能接上，
 * 关掉标签页即清空，不在服务端留存。
 */
export function usePetChat() {
  const [messages, setMessages] = useState<PetChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<PetChatError | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<PetChatMessage[]>([]);
  const hydrated = useRef(false);
  const lastPersistAt = useRef(0);

  useEffect(() => {
    messagesRef.current = messages;
    if (!hydrated.current) return;
    const now = Date.now();
    if (streaming && now - lastPersistAt.current < STREAM_PERSIST_MS) return;
    lastPersistAt.current = now;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshotForStorage(messages, streaming)));
    } catch {
      /* 隐私模式或配额满：只是丢掉续接能力 */
    }
  }, [messages, streaming]);

  // 首次挂载后再读 sessionStorage，避免服务端与客户端首帧不一致
  useEffect(() => {
    const stored = loadStored();
    hydrated.current = true;
    if (stored.length) setMessages(stored);
    const last = stored.at(-1);
    const lastUser = stored.findLast((m) => m.role === "user");
    if (lastUser?.skill && (last?.role === "user" || last?.interrupted)) {
      setError({ message: "上次分析尚未完成，已保留进度。", retryable: true });
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async (text: string, skill?: SkillId) => {
    const content = text.trim();
    if (!content || abortRef.current) return;
    setError(null);
    // 等待首包期间显示该 Skill 自己的进度文案，不在前端写死
      setProgress(skill ? findSkill(skill)?.progress ?? null : null);

    const user: PetChatMessage = { id: newId(), role: "user", content, ...(skill ? { skill } : {}) };
    const reply: PetChatMessage = { id: newId(), role: "assistant", content: "" };
    const history = [...messagesRef.current.filter((m) => m.content), user];
    setMessages([...messagesRef.current, user, reply]);
    setStreaming(true);
    lastPersistAt.current = 0;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let acc = "";
    let raf = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const flush = () => {
      raf = 0;
      const text = acc;
      setMessages((list) => list.map((m) => (m.id === reply.id ? { ...m, content: text } : m)));
    };

    try {
      const startedAt = Date.now();
      let sourceWaitSince = 0;
      let res: Response;
      for (;;) {
        const requestedAt = Date.now();
        res = await fetchWithTimeout("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 必须是字符串：握手未完成时 fetchWithTimeout 会原样重发
        body: skill ? JSON.stringify({ skill }) : chatRequestBody(history),
        signal: ctrl.signal,
        }, FIRST_BYTE_TIMEOUT_MS);
        if (!skill || res.status !== 202) break;
        const state = await res.json() as { phase?: string; completed?: number; total?: number };
        if (state.phase === "sources") sourceWaitSince ||= Date.now();
        else sourceWaitSince = 0;
        if (sourceWaitSince && Date.now() - sourceWaitSince > 330_000) throw new ChatHttpError("文章依据尚未同步完成，请稍后重试。", 504);
        setProgress(state.phase === "sources" ? "正在更新文章依据" : state.phase === "synthesize"
          ? "正在关联观点与核对原文"
          : `正在阅读文章（${Number(state.completed) || 0}/${Number(state.total) || 0}）`);
        if (Date.now() - startedAt > ANALYSIS_LIMIT_MS) throw new ChatHttpError("分析仍在处理中，已保留进度，请稍后重试。", 504);
        // 服务端每分钟8次；包括多批处理也保持请求间隔，停止时可立即打断。
        await waitForAnalysis(Math.max(250, 9_000 - (Date.now() - requestedAt)), ctrl.signal);
      }
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new ChatHttpError(j?.error || `请求失败（${res.status}）`, res.status);
      }
      setTier(res.headers.get("X-Persona-Tier"));
      // agent 模式（工具循环）按 NDJSON 事件流解析；普通路径仍是纯文本流。
      // 兼容策略：按响应头判断，不认识的事件行丢弃，普通文本一旦到来就走旧路径逻辑。
      const ndjson = (res.headers.get("Content-Type") ?? "").includes("x-ndjson");
      reader = res.body.getReader();
      const dec = new TextDecoder();
      let raw = "";
      let progressShown = false;
      const handleEvent = (line: string) => {
        if (!line.trim()) return;
        let evt: { t?: unknown; v?: unknown; label?: unknown; msg?: unknown };
        try {
          evt = JSON.parse(line) as typeof evt;
        } catch {
          return; // NDJSON 应保证整行；解析不了的残片丢弃，不影响正文
        }
        if (evt.t === "delta" && typeof evt.v === "string") {
          acc += evt.v;
          // 正文一旦开始，进度文案让位；服务端保证 delta 只出现在答案里
          if (progressShown) {
            progressShown = false;
            setProgress(null);
          }
          // rAF 合批：逐字到达时不必每个 chunk 都触发一次渲染
          if (!raf) raf = requestAnimationFrame(flush);
        } else if (evt.t === "step" && typeof evt.label === "string") {
          progressShown = true;
          setProgress(evt.label);
        } else if (evt.t === "error") {
          throw new ChatHttpError(typeof evt.msg === "string" ? evt.msg : "模型暂时没有响应，请稍后再试。", 502);
        }
        // "done" 与未知事件类型到这里自然结束
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        if (ndjson) {
          raw += chunk;
          let nl = raw.indexOf("\n");
          while (nl >= 0) {
            handleEvent(raw.slice(0, nl));
            raw = raw.slice(nl + 1);
            nl = raw.indexOf("\n");
          }
        } else {
          acc += chunk;
          if (!raf) raf = requestAnimationFrame(flush);
        }
      }
      const tail = dec.decode();
      if (ndjson) {
        raw += tail;
        if (raw.trim()) handleEvent(raw);
      } else {
        acc += tail;
      }
      if (raf) cancelAnimationFrame(raf);
      flush();
      if (!acc.trim()) throw new ChatHttpError("没有收到回复，请重试。", 502);
    } catch (e) {
      // 出错/中断时显式取消 reader：不让连接半开、服务端继续计费
      if (reader) void reader.cancel().catch(() => {});
      if (raf) cancelAnimationFrame(raf);
      const stopped = ctrl.signal.aborted;
      setMessages((list) =>
        list
          .map((m) => (m.id === reply.id ? { ...m, content: acc, interrupted: !!acc && (!stopped || !!skill) } : m))
          .filter((m) => m.id !== reply.id || m.content),
      );
      if (stopped && skill) {
        setError({ message: "分析已停止，已保留进度。", retryable: true });
      } else if (!stopped) {
        // 只有服务端 JSON 给出的文案原样显示；浏览器的网络错误（英文、各家不同）统一换成中文
        setError(
          e instanceof ChatHttpError
            ? { message: e.message, retryable: isRetryableStatus(e.status) }
            : { message: acc ? "回复中断了，可以点重试。" : "连接失败，请稍后重试。", retryable: true },
        );
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setProgress(null);
    }
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }, []);

  /** 重发最后一条提问：去掉它之后的回复（含断掉的半截）再发一次 */
  const retry = useCallback(() => {
    const list = messagesRef.current;
    const lastUserIdx = list.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx < 0) return;
    const { content: question, skill } = list[lastUserIdx];
    const kept = list.slice(0, lastUserIdx);
    messagesRef.current = kept;
    setMessages(kept);
    void send(question, skill);
  }, [send]);

  return { messages, streaming, progress, error, tier, send, stop, reset, retry };
}
