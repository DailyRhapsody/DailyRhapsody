"use client";

import { useEffect, useRef } from "react";

/**
 * 思维大树全屏覆盖层。
 * v15 先以同源 iframe 接入：关闭即卸载，v15 的动画不会在后台继续跑。
 * 覆盖层只负责打开、关闭、滚动锁与焦点归还；树本身的交互留在 iframe 内。
 */
export function CognitiveTreeOverlay({
  open,
  onClose,
  onOpenEntry,
}: {
  open: boolean;
  onClose: () => void;
  onOpenEntry?: (entryId: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const onOpenEntryRef = useRef(onOpenEntry);

  useEffect(() => {
    onCloseRef.current = onClose;
    onOpenEntryRef.current = onOpenEntry;
  }, [onClose, onOpenEntry]);

  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; entryId?: string | number } | null;
      if (data?.type !== "dr:open-entry" || data.entryId == null) return;
      onOpenEntryRef.current?.(String(data.entryId));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[400] bg-[#070503]"
      role="dialog"
      aria-modal="true"
      aria-label="思维大树"
    >
      <iframe
        ref={iframeRef}
        src="/tree/v15-oak.html?v=269"
        title="思维大树"
        className="absolute inset-0 h-full w-full border-0"
        referrerPolicy="no-referrer"
      />
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="关闭思维大树"
        title="关闭"
        className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/40 text-zinc-200 backdrop-blur transition-colors hover:border-white/35 hover:text-white"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
