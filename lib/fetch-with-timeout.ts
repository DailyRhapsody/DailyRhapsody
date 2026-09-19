/**
 * 带超时的 fetch 包装。
 * - 默认 30 秒超时（应对 Vercel function 冷启动 + Notion API 缓存 MISS 时的全量拉取，
 *   diaries 全量冷拉实测 20-53s。原 12s 默认在缓存失效后会 abort 导致空白页）
 * - 重试圈沿用同一超时预算。曾经用 8s「因为缓存已建好」——但重试恰恰发生在
 *   握手刚完成的首帧，此时缓存完全可能是冷的：8s 预算对 20s+ 的冷后端是
 *   确定性失败（2026-08 事故的放大器之一）。
 * - 单次重试超时抛 AbortError 不再终止整条重试链，只算一次失败。
 * - 如果调用方传了自己的 signal，会尊重它（任一触发即中止）
 * - 受保护接口的 403（没有 dr_gate）会等待 GateClient 完成 PoW 握手后阶梯重试。
 */

const GATE_READY_EVENT = "dr-gate-ready";
const GATE_DONE_FLAG = "dr_gate_done";
const GATE_WAIT_TIMEOUT_MS = 8000;

function gateAlreadyDone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(GATE_DONE_FLAG) === "1";
  } catch {
    return false;
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** 可被调用方 signal 打断的等待：握手等待与退避期间点「停止」要立即生效 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError(signal!));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForGateReady(signal?: AbortSignal | null): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (gateAlreadyDone()) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let done = false;
    function cleanup() {
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener(GATE_READY_EVENT, onReady as EventListener);
      signal?.removeEventListener("abort", onAbort);
    }
    function finish(ok: boolean) {
      if (done) return;
      cleanup();
      resolve(ok);
    }
    function onAbort() {
      if (done) return;
      cleanup();
      reject(abortError(signal!));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    function onReady() { finish(true); }
    // 关键：除了监听事件，再开一个轮询兜底。
    // 因为 fetchWithTimeout 第一次拿到 403 后才进入这里 addEventListener，
    // GateClient 可能在我们注册监听器之前就已经 dispatch 完事件并写好
    // sessionStorage 标记 —— 此时事件丢失但 gateAlreadyDone() 能查到。
    const poll = setInterval(() => { if (gateAlreadyDone()) finish(true); }, 100);
    const timer = setTimeout(() => finish(false), GATE_WAIT_TIMEOUT_MS);
    window.addEventListener(GATE_READY_EVENT, onReady as EventListener);
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
  return /\/api\/(diaries|moments|profile|chat)/.test(url);
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

  const res = await rawFetch(input, initWithCreds, timeoutMs);

  // 受保护接口拿到 403：可能是 GateClient 还没完成握手。
  // 退避重试最多 3 次（间隔 400ms / 1200ms / 2500ms），每次重试前重新检查
  // sessionStorage 标记，避免单次重试错过握手完成的窗口。
  if (res.status === 403 && isProtectedApi(input) && typeof window !== "undefined") {
    const ready = await waitForGateReady(init.signal);
    if (ready) {
      const retryDelays = [400, 1200, 2500];
      // 重试圈沿用 timeoutMs（默认 30s）：重试发生在握手刚完成的首帧，服务端
      // 缓存可能是冷的（diaries 全量冷拉 20-53s），预算必须覆盖冷路径。
      // 单次超时（AbortError）不终止重试链——吞掉异常继续下一轮，把「一次
      // 网络超时」与「重试机会用尽」区分开。调用方自带的 signal 中止除外。
      // 全链总 deadline 60s：冷拉在 60s 内必然写好缓存（实测上界 53s），
      // 之后的重试没有意义，别把用户挂在「加载中」两三分钟。
      const deadline = Date.now() + 60_000;
      let lastRes: Response | null = null;
      let lastErr: unknown = null;
      const attempt = async (): Promise<void> => {
        try {
          // 单次预算不超过剩余 deadline，保证全链不显著超 60s
          const budget = Math.min(timeoutMs, Math.max(1000, deadline - Date.now()));
          lastRes = await rawFetch(input, initWithCreds, budget);
          lastErr = null;
        } catch (e) {
          if (init.signal?.aborted) throw e; // 调用方主动中止，如实上抛
          lastRes = null;
          lastErr = e;
        }
      };
      await attempt();
      for (let i = 0; i < retryDelays.length; i++) {
        if (lastRes && (lastRes as Response).status !== 403) return lastRes;
        if (Date.now() >= deadline) break;
        await sleep(retryDelays[i], init.signal);
        if (!gateAlreadyDone()) {
          const reReady = await waitForGateReady(init.signal);
          if (!reReady) break;
        }
        await attempt();
      }
      if (lastRes) return lastRes;
      throw lastErr;
    }
  }
  return res;
}
