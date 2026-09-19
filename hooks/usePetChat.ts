"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

export type PetChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 回复中途断掉（网络、上游报错），保留已到达的部分并标记 */
  interrupted?: boolean;
};

const STORAGE_KEY = "dr_pet_chat_v1";
/** 发给服务端的历史轮数，与服务端 CHAT_LIMITS.maxTurns 一致 */
const HISTORY_TURNS = 16;
/** 首包等待：服务端上游超时 55s，默认的 30s 会先把慢模型砍掉 */
const FIRST_BYTE_TIMEOUT_MS = 65_000;
/** 流式期间落盘节流：整页跳转或刷新时，至少保住提问与已到达的半截回答 */
const STREAM_PERSIST_MS = 1_000;

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
    const list = raw ? (JSON.parse(raw) as PetChatMessage[]) : [];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.content === "string") : [];
  } catch {
    return [];
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 数字人对话状态。对话只存在本标签页的 sessionStorage：站内链接整页跳转后能接上，
 * 关掉标签页即清空，不在服务端留存。
 */
export function usePetChat() {
  const [messages, setMessages] = useState<PetChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
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
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || abortRef.current) return;
    setError(null);

    const user: PetChatMessage = { id: newId(), role: "user", content };
    const reply: PetChatMessage = { id: newId(), role: "assistant", content: "" };
    const history = [...messagesRef.current.filter((m) => m.content), user];
    setMessages([...messagesRef.current, user, reply]);
    setStreaming(true);
    lastPersistAt.current = 0;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let acc = "";
    let raf = 0;
    const flush = () => {
      raf = 0;
      const text = acc;
      setMessages((list) => list.map((m) => (m.id === reply.id ? { ...m, content: text } : m)));
    };

    try {
      const res = await fetchWithTimeout("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 必须是字符串：握手未完成时 fetchWithTimeout 会原样重发
        body: JSON.stringify({
          messages: history.slice(-HISTORY_TURNS).map(({ role, content }) => ({ role, content })),
        }),
        signal: ctrl.signal,
      }, FIRST_BYTE_TIMEOUT_MS);
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new ChatHttpError(j?.error || `请求失败（${res.status}）`, res.status);
      }
      setTier(res.headers.get("X-Persona-Tier"));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        // rAF 合批：逐字到达时不必每个 chunk 都触发一次渲染
        if (!raf) raf = requestAnimationFrame(flush);
      }
      acc += dec.decode();
      if (raf) cancelAnimationFrame(raf);
      flush();
      if (!acc.trim()) throw new ChatHttpError("没有收到回复，请重试。", 502);
    } catch (e) {
      if (raf) cancelAnimationFrame(raf);
      const stopped = ctrl.signal.aborted;
      setMessages((list) =>
        list
          .map((m) => (m.id === reply.id ? { ...m, content: acc, interrupted: !stopped && !!acc } : m))
          .filter((m) => m.id !== reply.id || m.content),
      );
      if (!stopped) {
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
    const question = list[lastUserIdx].content;
    const kept = list.slice(0, lastUserIdx);
    messagesRef.current = kept;
    setMessages(kept);
    void send(question);
  }, [send]);

  return { messages, streaming, error, tier, send, stop, reset, retry };
}
