/**
 * 带超时的 fetch 包装。
 * - 默认 30 秒超时（应对 Vercel function 冷启动 + Notion API 缓存 MISS 时的全量拉取，
 *   diaries 全量冷拉实测 20-53s。原 12s 默认在缓存失效后会 abort 导致空白页）
 * - 如果调用方传了自己的 signal，会尊重它（任一触发即中止）
 * - 受保护接口先等门闸就绪（lib/gate-handshake.ts 的 ensureGate）再发：凭据缺失或过期时
 *   不先吃一轮 403（没有 dr_seed 的 403 会计违规，4 次封 IP）。仍拿到 403 说明服务端不认这份
 *   凭据，作废提示、重新握手后重试一次；重试沿用同一超时预算（握手刚完成时后端缓存可能是冷的）。
 */
import { ensureGate, invalidateGate } from "@/lib/gate-handshake";

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** 等门闸就绪，但调用方 signal 一中止就立即以 AbortError 结束（握手本身不因某个调用方离开而取消） */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function rawFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const userSignal = init.signal;
  if (userSignal) {
    if (userSignal.aborted) {
      ctrl.abort();
    } else {
      userSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
  }

  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isProtectedApi(input: RequestInfo | URL): boolean {
  let url = "";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.toString();
  else if (input && typeof (input as Request).url === "string") url = (input as Request).url;
  return /\/api\/(diaries|moments|profile|chat|reference|persona|analytics\/visitor-map)(\/|\?|$)/.test(url);
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 30_000
): Promise<Response> {
  // 默认带 cookie，避免组件忘记加 credentials 导致 dr_gate 没发出去
  const initWithCreds: RequestInit = {
    credentials: init.credentials ?? "same-origin",
    ...init,
  };

  const gated = typeof window !== "undefined" && isProtectedApi(input);
  const ready = gated && (await abortable(ensureGate(), init.signal));
  const res = await rawFetch(input, initWithCreds, timeoutMs);
  if (!ready || res.status !== 403) return res;

  // 提示说有凭据、服务端却不认（AUTH_SECRET 轮换、dr_gate 被单独删掉）：并发的 403 共用一次握手
  invalidateGate();
  if (!(await abortable(ensureGate(), init.signal))) return res;
  return rawFetch(input, initWithCreds, timeoutMs);
}
