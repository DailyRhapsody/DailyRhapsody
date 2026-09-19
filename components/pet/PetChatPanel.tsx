"use client";

import { usePathname } from "next/navigation";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePetChat } from "@/hooks/usePetChat";
import { chatProseClass, renderChatMarkdown } from "@/lib/chat-markdown";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

type Status = { ready: boolean; tier: string };

const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  const html = useMemo(() => renderChatMarkdown(text), [text]);
  return <div className={chatProseClass} dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * 手机上贴底的输入胶囊要躲开软键盘：iOS 弹键盘时不缩布局视口，
 * 只能跟着 visualViewport 算出键盘占掉的底部高度。
 */
function useKeyboardInset(active: boolean) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) return;
    const update = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);
  return active ? inset : 0;
}

/** 右侧空白栏至少要这么宽才放得下对话；更窄（手机、小屏）时退回页面底部浮字 */
const GUTTER_MIN_WIDTH = 200;
const GUTTER_MAX_WIDTH = 480;

/**
 * 宽屏时把对话放进正文列右侧的空白栏：从页面顶部到右下角宠物上方。
 * 按当前页面 main 的右边缘实时计算，窗口缩放、换页后重算。
 */
function useGutterBox(active: boolean, pathname: string | null) {
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    const measure = () => {
      const vw = document.documentElement.clientWidth;
      const main = document.querySelector("main");
      const contentRight = main ? main.getBoundingClientRect().right : vw;
      const start = Math.round(contentRight + 24);
      const room = vw - start - 24;
      if (room < GUTTER_MIN_WIDTH) {
        setBox(null);
        return;
      }
      const width = Math.min(room, GUTTER_MAX_WIDTH);
      // 空白栏比上限还宽时居中摆放
      setBox({ left: start + Math.round((room - width) / 2), width });
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, pathname]);
  return active ? box : null;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * 仿 Apple Intelligence 新版 Siri：没有白框，对话浮在页面上。
 * 宽屏放进正文右侧的空白栏（从顶部到宠物上方），有内容时垫一层磨砂半透明底：
 * 评论线程也在这条栏里，不垫的话两边文字会叠在一起。
 * 空白栏不够宽时浮在页面底部，背后加一层渐隐柔化。
 * 对话期间左上角头像的呼吸灯变成彩色光环（由 PetLauncher 在根节点打标记）。
 */
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
  const small = useMediaQuery("(max-width: 639px)");
  const keyboardInset = useKeyboardInset(open && small);
  const pathname = usePathname();
  const gutter = useGutterBox(open, pathname);

  useEffect(() => onThinkingChange(chat.streaming), [chat.streaming, onThinkingChange]);

  // 首次打开时查询可用性，只查一次：握手没过的 403 会记违规，不能每次打开都重来。
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

  // Esc 只在焦点位于对话内时关闭：页面上评论框、菜单的 Esc 不连带关掉；
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

  const notReady = !!status && !status.ready;

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

  // 输入框随内容长高，最多约 5 行。刚挂载时布局与字体可能还没就绪，量出来会偏高，
  // 所以每次打开都在下一帧重量一次
  useEffect(() => {
    const fit = () => {
      const el = inputRef.current;
      if (!el || el.clientWidth === 0) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 124)}px`;
    };
    fit();
    const raf = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(raf);
  }, [draft, open]);

  const last = chat.messages[chat.messages.length - 1];
  const waitingFirstToken = chat.streaming && last?.role === "assistant" && !last.content;
  const hasContent = chat.messages.length > 0 || !!chat.error;
  const glass = !!gutter && hasContent;
  // 苹果式玻璃：底色很淡、模糊半径小，背后内容以虚化轮廓透出。不做描边、圆角与投影，
  // 整条右侧栏铺成一层，边缘用径向蒙版淡出，看不出起止
  const glassSurface = "bg-white/20 backdrop-blur-md backdrop-saturate-[1.8] dark:bg-zinc-900/20";
  const glassTransition =
    "transition-[background-color,-webkit-backdrop-filter,backdrop-filter] duration-[350ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none";
  // 淡入淡出不放在根节点、也不放在磨砂卡片上：Chrome 里元素自身或祖先透明度小于 1 时 backdrop-filter 不生效，
  // 打开的过渡期间背后评论会清晰透出。磨砂卡片改为底色与模糊一起渐入，文字等其余部分各自淡入
  const fade = `transition-apple transition-apple-slow motion-reduce:transition-none ${open ? "opacity-100" : "opacity-0"}`;

  // 宽屏：正文右侧空白栏，从顶部到宠物上方（宠物占底部约 104px）；否则浮在页面底部
  const rootStyle = gutter
    ? { left: gutter.left, width: gutter.width, top: 24, bottom: 120, transitionProperty: "translate" }
    : { left: 0, right: 0, bottom: keyboardInset, transitionProperty: "translate" };

  return (
    <div
      role="dialog"
      aria-label="滕君的 AI 分身"
      aria-hidden={!open}
      inert={!open}
      data-pet-chat
      onKeyDown={onPanelKeyDown}
      style={rootStyle}
      className={`pointer-events-none fixed z-[100] flex flex-col justify-end font-sans transition-apple transition-apple-slow motion-reduce:translate-y-0 motion-reduce:transition-none ${
        open ? "translate-y-0" : "invisible translate-y-4"
      }`}
    >
      {/* 浮在正文上方时：文字背后一层向上渐隐的柔化，没有边框。右侧空白栏里改由对话列表自己垫磨砂底 */}
      {!gutter && (
        <div
          aria-hidden="true"
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-white/85 via-white/55 to-transparent backdrop-blur-md [mask-image:linear-gradient(to_top,black_55%,transparent)] dark:from-black/80 dark:via-black/50 ${fade} ${
            hasContent ? "-top-24" : "-top-10"
          }`}
        />
      )}

      {/* 整条右侧栏的玻璃层：比文字范围向外扩一圈，边缘径向淡出，看不到边界。
          纯装饰，不挡点击；评论等内容从下面经过时透出虚化轮廓 */}
      {glass && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute -inset-x-6 -top-6 -bottom-8 [mask-image:radial-gradient(115%_92%_at_50%_50%,black_58%,transparent_100%)] ${glassTransition} ${
            open ? glassSurface : ""
          }`}
        />
      )}

      <div
        className={`relative flex min-h-0 w-full flex-col ${
          gutter ? "h-full justify-end" : "mx-auto max-w-[640px] px-4 pb-4 sm:pb-6"
        }`}
      >
          <div className="flex min-h-0 flex-col">
            <div
              ref={listRef}
              onScroll={onScroll}
              className={`pointer-events-auto min-h-0 overflow-y-auto overscroll-contain leading-relaxed text-zinc-900 [scrollbar-width:none] dark:text-zinc-100 ${fade} ${
                // 与博客正文同字号同行高（EntrySummary：0.8125rem 即 13px、leading-relaxed）
                gutter ? "text-[0.8125rem]" : "max-h-[52vh] text-[0.8125rem]"
              } ${
                glass
                  ? // 内边距放在滚动容器上：卡片边缘也能滚动对话，键盘焦点框不被裁掉
                    "p-4 [mask-image:linear-gradient(to_bottom,transparent,black_16px)]"
                  : `[mask-image:linear-gradient(to_bottom,transparent,black_40px)] ${hasContent ? "pb-4 pt-10" : ""}`
              }`}
            >
              <div className="space-y-5">
                {chat.messages.map((m) =>
                  m.role === "user" ? (
                    <p
                      key={m.id}
                      className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words text-right text-[0.8125rem] text-zinc-500 dark:text-zinc-400"
                    >
                      {m.content}
                    </p>
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
                  <div role="alert" className="flex items-center gap-2 text-[0.8rem] text-zinc-500 dark:text-zinc-400">
                    <span>{chat.error.message}</span>
                    {chat.error.retryable && (
                      <button
                        type="button"
                        onClick={chat.retry}
                        className="px-1 text-zinc-900 underline decoration-zinc-400 underline-offset-2 dark:text-zinc-100"
                      >
                        重试
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <p className="sr-only" aria-live="polite">
            {chat.streaming ? "" : last?.role === "assistant" && last.content ? "已回复" : ""}
          </p>

          {/* 输入胶囊：半透明，不做白底框 */}
          <div
            className={`pointer-events-auto mt-2 flex items-end gap-2 rounded-[22px] py-2 pl-4 pr-2 ${glassSurface} ${glassTransition} focus-within:bg-white/35 dark:focus-within:bg-white/10 ${fade}`}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={2000}
              disabled={notReady}
              placeholder={notReady ? "还在准备中" : "问问滕君的 AI 分身"}
              aria-label="输入消息"
              // 全局 :focus-visible 轮廓不在 layer 里，工具类盖不过
              style={{ outline: "none" }}
              // 上下各 2px 内边距，单行时文字与右侧 28px 的按钮垂直居中；
              // 手机上字号不低于 16px，否则 iOS 聚焦时会整页放大
              className="block max-h-[124px] min-h-7 flex-1 resize-none bg-transparent py-0.5 text-base leading-6 text-zinc-900 placeholder:text-zinc-500 disabled:cursor-not-allowed dark:text-zinc-100 dark:placeholder:text-zinc-400 sm:text-[0.8125rem]"
            />
            {chat.streaming ? (
              <button
                type="button"
                onClick={chat.stop}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-apple hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                aria-label="停止生成"
                title="停止生成"
              >
                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
              </button>
            ) : draft.trim() ? (
              <button
                type="button"
                onClick={() => submit()}
                disabled={notReady}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-apple hover:bg-zinc-700 disabled:opacity-40 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                aria-label="发送"
                title="发送"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-apple hover:bg-black/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
                aria-label="收起"
                title="收起"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            )}
          </div>
      </div>
    </div>
  );
}
