"use client";

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePetChat } from "@/hooks/usePetChat";
import { chatProseClass, renderChatMarkdown } from "@/lib/chat-markdown";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { PixelAstronaut } from "@/components/pet/PixelAstronaut";

type Status = { ready: boolean; tier: string; starters: string[] };

const DEFAULT_STARTERS = ["你是谁？", "最近在想什么？", "推荐一篇你写过的文章"];

const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  const html = useMemo(() => renderChatMarkdown(text), [text]);
  return <div className={chatProseClass} dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * 手机上贴底的抽屉要躲开软键盘：iOS 弹键盘时不缩布局视口，
 * 只能跟着 visualViewport 算出可见区域的高度与底部偏移。
 */
function useVisualViewportBox(active: boolean) {
  const [box, setBox] = useState<{ height: number; bottom: number } | null>(null);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) return;
    const update = () =>
      setBox({ height: vv.height, bottom: Math.max(0, window.innerHeight - vv.height - vv.offsetTop) });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);
  return box;
}

function useIsSmallScreen() {
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setSmall(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return small;
}

export function PetChatPanel({
  open,
  onClose,
  onThinkingChange,
}: {
  open: boolean;
  onClose: () => void;
  onThinkingChange: (thinking: boolean) => void;
}) {
  const chat = usePetChat();
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const statusRequested = useRef(false);
  const small = useIsSmallScreen();
  const vvBox = useVisualViewportBox(open && small);

  useEffect(() => onThinkingChange(chat.streaming), [chat.streaming, onThinkingChange]);

  // 首次打开时查询可用性与开场问题，只查一次：握手没过的 403 会记违规，不能每次开面板都重来。
  // 查询失败不阻塞输入，发送时服务端会给出具体原因
  useEffect(() => {
    if (!open || statusRequested.current) return;
    statusRequested.current = true;
    fetchWithTimeout("/api/chat")
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => {
        if (s) setStatus(s);
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open || small) return;
    const t = setTimeout(() => inputRef.current?.focus(), 180);
    return () => clearTimeout(t);
  }, [open, small]);

  // 手机上抽屉盖住大半屏：锁住背后页面，免得在标题栏、输入区拖动时带着页面滚
  useEffect(() => {
    if (!open || !small) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open, small]);

  // 用户往上翻看历史时不强行拉回底部
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, open]);

  // 键盘弹起、输入框长高会让列表变矮：贴底状态下跟着留在底部，最新回复不被挤出可视区
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Esc 只在焦点位于面板内时关闭：页面上评论框、菜单的 Esc 不连带关掉面板；
  // 输入法组字时的 Esc 是取消候选词
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.stopPropagation();
    onClose();
  };

  const onScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const submit = (text = draft) => {
    if (!text.trim() || chat.streaming || notReady) return;
    stickToBottom.current = true;
    void chat.send(text);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字中的回车是选词，不是发送；Safari 组字结束后还会补发一个 keyCode 229 的回车
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key !== "Enter" || e.shiftKey) return;
    // 触屏上回车换行、用按钮发送，与评论框一致
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    e.preventDefault();
    submit();
  };

  // 输入框随内容长高，最多约 6 行。面板刚挂载时布局与字体可能还没就绪，量出来会偏高，
  // 所以每次打开都在下一帧重量一次
  useEffect(() => {
    const fit = () => {
      const el = inputRef.current;
      if (!el || el.clientWidth === 0) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
    };
    fit();
    const raf = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(raf);
  }, [draft, open]);

  const owner = (chat.tier ?? status?.tier) === "owner";
  const starters = status?.starters.length ? status.starters : DEFAULT_STARTERS;
  const notReady = !!status && !status.ready;
  const last = chat.messages[chat.messages.length - 1];
  const waitingFirstToken = chat.streaming && last?.role === "assistant" && !last.content;

  const mobileStyle = small
    ? { height: vvBox ? Math.round(vvBox.height * 0.92) : "85dvh", bottom: vvBox?.bottom ?? 0 }
    : undefined;

  return (
    <div
      role="dialog"
      aria-label="滕君的 AI 分身"
      aria-hidden={!open}
      inert={!open}
      data-pet-chat
      onKeyDown={onPanelKeyDown}
      // Tailwind v4 的 translate-y-* 走独立的 translate 属性，transition-apple 只过渡 transform，这里补上
      style={{ ...mobileStyle, transitionProperty: "opacity, translate" }}
      className={`fixed z-[100] flex flex-col overflow-hidden bg-white/85 font-sans text-zinc-900 shadow-2xl ring-1 ring-black/5 backdrop-blur-xl transition-apple transition-apple-slow motion-reduce:translate-y-0 dark:bg-zinc-900/85 dark:text-zinc-100 dark:ring-white/10 max-sm:inset-x-0 max-sm:rounded-t-2xl sm:bottom-[112px] sm:right-6 sm:h-[min(600px,calc(100dvh-144px))] sm:w-[380px] sm:rounded-2xl ${
        open ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
      }`}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <PixelAstronaut scale={1.5} still />
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-[15px] font-medium">滕君</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">AI 分身</span>
        </div>
        {owner && (
          <span className="rounded-full bg-zinc-900/5 px-2 py-0.5 text-[11px] text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
            本人模式
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={chat.reset}
            disabled={chat.messages.length === 0}
            className="rounded-full p-2 text-zinc-500 transition-apple hover:bg-black/5 hover:text-zinc-900 disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
            aria-label="新对话"
            title="新对话"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-zinc-500 transition-apple hover:bg-black/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
            aria-label="收起"
            title="收起"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </header>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2 text-[15px] leading-relaxed"
      >
        {chat.messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-3 pb-6 text-center">
            <PixelAstronaut scale={4} />
            <p className="text-[15px] font-medium">你好，我是滕君的 AI 分身。</p>
            <p className="max-w-[16rem] text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              {notReady
                ? "还在准备中，过些天再来找我聊。"
                : owner
                  ? "本人模式：可以调用全部记忆，帮你回忆和梳理。"
                  : "我依据他写过的东西说话，可能有记错的地方。"}
            </p>
            {!notReady && (
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {starters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="rounded-full bg-zinc-900/5 px-3 py-1.5 text-[13px] text-zinc-700 transition-apple hover:bg-zinc-900/10 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            {chat.messages.map((m) =>
              m.role === "user" ? (
                <div
                  key={m.id}
                  className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-zinc-900/5 px-3.5 py-2 dark:bg-white/10"
                >
                  {m.content}
                </div>
              ) : (
                <div key={m.id}>
                  {m.content ? <AssistantText text={m.content} /> : null}
                  {m.interrupted && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">（回复中断）</p>}
                </div>
              ),
            )}
            {waitingFirstToken && (
              <div className="flex gap-1 py-1" role="status">
                <span className="sr-only">正在思考</span>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="dr-pet-dot h-1.5 w-1.5 rounded-full bg-zinc-400"
                    style={{ animationDelay: `${i * 160}ms` }}
                  />
                ))}
              </div>
            )}
            {chat.error && (
              <div role="alert" className="flex items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400">
                <span>{chat.error.message}</span>
                {chat.error.retryable && (
                  <button
                    type="button"
                    onClick={chat.retry}
                    className="rounded-full px-2 py-0.5 text-zinc-900 underline decoration-zinc-400 underline-offset-2 dark:text-zinc-100"
                  >
                    重试
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {chat.streaming ? "" : last?.role === "assistant" && last.content ? "已回复" : ""}
      </p>

      <div className="shrink-0 px-3 pb-2 pt-1">
        <div className="flex items-end gap-2 rounded-2xl bg-white/70 px-3 py-2 ring-1 ring-black/5 transition-apple focus-within:ring-black/15 dark:bg-zinc-800/60 dark:ring-white/10 dark:focus-within:ring-white/20">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={2000}
            disabled={notReady}
            placeholder={notReady ? "还在准备中" : "想问点什么？"}
            aria-label="输入消息"
            // 全局 :focus-visible 轮廓不在 layer 里，工具类盖不过；焦点态由外框 focus-within 表达
            style={{ outline: "none" }}
            // 手机上字号不低于 16px，否则 iOS 聚焦时会整页放大
            className="max-h-36 min-h-[24px] flex-1 resize-none bg-transparent text-base leading-6 placeholder:text-zinc-500 disabled:cursor-not-allowed dark:placeholder:text-zinc-400 sm:text-[15px]"
          />
          {chat.streaming ? (
            <button
              type="button"
              onClick={chat.stop}
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-apple hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              aria-label="停止生成"
              title="停止生成"
            >
              <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit()}
              disabled={!draft.trim() || notReady}
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-apple hover:bg-zinc-700 disabled:bg-zinc-900/15 disabled:text-white/90 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200 dark:disabled:bg-white/15 dark:disabled:text-zinc-900/60"
              aria-label="发送"
              title="发送"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" />
              </svg>
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
          AI 生成，可能有误，不代表本人即时观点
        </p>
      </div>
    </div>
  );
}
