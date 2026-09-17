"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { formatDate12h } from "@/lib/format";
import { createShareCardElement } from "@/lib/share-card";
import { DefaultAvatar } from "./DefaultAvatar";
import { EntrySummary } from "./EntrySummary";
import { EntryComments } from "./EntryComments";
import { legacyCopyTextToClipboard, splitBodyImages } from "./utils";
import type { Diary } from "./types";

export function EntryCard({
  item,
  authorName,
  avatarSrc,
  canEdit,
  onOpenImages,
}: {
  item: Diary;
  authorName: string;
  avatarSrc: string;
  canEdit: boolean;
  /** 点击首图放大：urls 为本篇全部图片，index 为点中的那张 */
  onOpenImages: (urls: string[], index: number) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [sharePreviewSrc, setSharePreviewSrc] = useState<string | null>(null);
  const [shareModalError, setShareModalError] = useState<string | null>(null);
  const [copyLinkHint, setCopyLinkHint] = useState<"ok" | "fail" | null>(null);
  // 优化器回源偶发失败（线上见过 /_next/image 400）时，改为直接加载代理原图
  const [unoptimizedSrcs, setUnoptimizedSrcs] = useState<ReadonlySet<string>>(() => new Set());
  // 直连也加载失败的（如正文里的视频 block）不再占首图位置，也不进灯箱
  const [brokenSrcs, setBrokenSrcs] = useState<ReadonlySet<string>>(() => new Set());
  const copyLinkHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shareUrlRef = useRef("");
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  // 正文里独占一行的图片并入首图，正文只留文字
  const { text: bodyText, images: bodyImages } = useMemo(
    () => splitBodyImages(item.summary),
    [item.summary]
  );
  const images = useMemo(
    () => [...new Set([...(item.images ?? []), ...bodyImages])].filter((src) => !brokenSrcs.has(src)),
    [item.images, bodyImages, brokenSrcs]
  );

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const root = menuRootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const closeShareModal = useCallback(() => {
    setShareModalOpen(false);
    setSharePreviewSrc(null);
    setShareModalError(null);
    setCopyLinkHint(null);
    if (copyLinkHintTimerRef.current) {
      clearTimeout(copyLinkHintTimerRef.current);
      copyLinkHintTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!shareModalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeShareModal();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [shareModalOpen, closeShareModal]);

  async function copyShareUrl(shareUrl: string) {
    const trimmed = shareUrl.trim();
    if (copyLinkHintTimerRef.current) {
      clearTimeout(copyLinkHintTimerRef.current);
      copyLinkHintTimerRef.current = null;
    }
    if (!trimmed) {
      setCopyLinkHint("fail");
      copyLinkHintTimerRef.current = setTimeout(() => setCopyLinkHint(null), 2600);
      return;
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(trimmed);
      ok = true;
    } catch {
      ok = legacyCopyTextToClipboard(trimmed);
      if (!ok) window.prompt("复制以下链接分享：", trimmed);
    }
    setCopyLinkHint(ok ? "ok" : "fail");
    copyLinkHintTimerRef.current = setTimeout(() => setCopyLinkHint(null), 2600);
  }

  async function openShareImageModal() {
    if (typeof window === "undefined") return;
    const shareUrl = `${window.location.origin}${window.location.pathname}#entry-${item.id}`;
    shareUrlRef.current = shareUrl;
    setMenuOpen(false);
    setShareModalOpen(true);
    setSharePreviewSrc(null);
    setShareModalError(null);
    setSharing(true);

    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-9999px;top:0;overflow:visible;opacity:1;pointer-events:none;z-index:-1";

    const card = createShareCardElement({
      summary: bodyText,
      date: item.date,
      publishedAt: item.publishedAt,
      entryId: item.id,
      authorName,
      tags: item.tags,
    });
    host.appendChild(card);
    document.body.appendChild(host);

    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(card, {
        scale: 3,
        useCORS: true,
        logging: false,
        backgroundColor: "#F7F8FA",
      });
      setSharePreviewSrc(canvas.toDataURL("image/png", 0.95));
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.error(err);
      setShareModalError("生成图片失败，请稍后重试");
    } finally {
      host.remove();
      setSharing(false);
    }
  }

  async function shareImageFromPreview() {
    const src = sharePreviewSrc;
    if (!src) return;
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const file = new File([blob], "DailyRhapsody.png", { type: "image/png" });
      const shareUrl = shareUrlRef.current;
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "DailyRhapsody",
          text: "分享自 DailyRhapsody",
          url: shareUrl,
        });
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") await copyShareUrl(shareUrlRef.current);
    }
  }

  function downloadShareImage() {
    if (!sharePreviewSrc) return;
    const a = document.createElement("a");
    a.href = sharePreviewSrc;
    a.download = "DailyRhapsody.png";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function handleShare() {
    if (sharing) return;
    if (typeof window === "undefined") return;
    void openShareImageModal();
  }

  const timeStr = formatDate12h(
    item.publishedAt ?? item.date + "T12:00:00"
  );
  const locationMapUrl = item.location
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}`
    : "";

  return (
    <>
    <article
      id={`entry-${item.id}`}
      className="group relative flex flex-col gap-3 rounded-2xl px-3 py-4 transition-apple scroll-mt-24 hover:bg-zinc-100/70 hover:shadow-md dark:hover:bg-zinc-900/80 dark:hover:shadow-black/10"
    >
      <div className="flex items-start gap-3">
        <DefaultAvatar src={avatarSrc} className="h-10 w-10 shrink-0" />
                    <div className="min-h-10 flex min-w-0 flex-1 flex-col justify-center">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                        {authorName}
                      </p>
          <p className="text-[0.75rem] text-zinc-500 dark:text-zinc-400">
            {timeStr}
          </p>
          {canEdit && item.isPublic === false && (
            <span className="mt-1 w-fit rounded bg-zinc-200/80 px-1.5 py-0.5 text-[0.65rem] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
              私密
            </span>
          )}
        </div>
        <div ref={menuRootRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
            aria-label="更多"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="6" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="18" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <>
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[6rem] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                {canEdit && (
                  <Link
                    href={`/admin/diaries/${item.id}/edit`}
                    className="block w-full px-3 py-2 text-left text-[0.8rem] text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    onClick={() => setMenuOpen(false)}
                  >
                    编辑
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setCommentsOpen(true);
                    setMenuOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left text-[0.8rem] text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  评论
                </button>
                <button
                  type="button"
                  onClick={() => handleShare()}
                  disabled={sharing}
                  className="w-full px-3 py-2 text-left text-[0.8rem] text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {sharing ? "生成中…" : "分享"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {images.length > 0 && (
        // p-1/-m-1 给键盘焦点框留出位置，否则会被 overflow-hidden 裁掉
        <div className="-m-1 flex gap-1 overflow-hidden rounded-xl p-1">
          {images.slice(0, 3).map((src, idx) => {
            // 只有公开文章的 Image 属性图走优化器（与改动前一致）：
            // 私密图优化器回源不带 cookie 会被拒；正文图直连代理，文章转私密后 5 分钟内失效，
            // 走优化器会被缓存 4 小时；外链图的域名不在 images 配置里，走优化器会直接报错
            const optimized =
              src.startsWith("/api/media/p/") && item.isPublic !== false && !unoptimizedSrcs.has(src);
            return (
              <button
                key={src}
                type="button"
                onClick={() => onOpenImages(images, idx)}
                aria-label={`查看大图 ${idx + 1}/${images.length}`}
                // 窄屏（<350px）三张 96px 放不下，按行宽三等分缩小，保持方图
                className="relative aspect-square w-[calc((100%-0.5rem)/3)] max-w-24 flex-shrink-0 cursor-zoom-in overflow-hidden rounded-lg bg-zinc-200 dark:bg-zinc-800 sm:h-20 sm:w-20"
              >
                <Image
                  src={src}
                  alt=""
                  fill
                  className="object-cover"
                  sizes="96px"
                  unoptimized={!optimized}
                  onError={() => {
                    if (optimized) setUnoptimizedSrcs((prev) => new Set(prev).add(src));
                    else setBrokenSrcs((prev) => new Set(prev).add(src));
                  }}
                />
              </button>
            );
          })}
        </div>
      )}
      {bodyText.trim() !== "" && <EntrySummary text={bodyText} />}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          {(item.tags ?? []).length > 0 ? (
            <div className="min-w-0 flex flex-wrap gap-1">
              {(item.tags ?? []).map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-zinc-200/80 px-1.5 py-0.5 text-[0.65rem] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : (
            <div />
          )}
          {item.location && (
            <a
              href={locationMapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="max-w-[48%] shrink-0 truncate text-right text-[0.72rem] text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
              title={`在地图中打开：${item.location}`}
            >
              📍 {item.location}
            </a>
          )}
        </div>
        <EntryComments
          diaryId={item.id}
          open={commentsOpen}
          onOpenChange={setCommentsOpen}
        />
      </div>
    </article>

    {shareModalOpen &&
      typeof document !== "undefined" &&
      createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-modal-title"
        >
          <button
            type="button"
            className="absolute inset-0 z-0 cursor-default border-0 bg-transparent"
            aria-label="关闭浮层"
            onClick={closeShareModal}
          />
          <div
            className="relative z-10 flex max-h-[min(92vh,900px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-zinc-900 dark:ring-1 dark:ring-zinc-700"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
              <h2
                id="share-modal-title"
                className="text-base font-semibold text-zinc-900 dark:text-zinc-50"
              >
                生成分享图片
              </h2>
              <button
                type="button"
                onClick={closeShareModal}
                className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="关闭"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex min-h-[120px] flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-4">
              {sharing && !sharePreviewSrc && !shareModalError && (
                <div className="flex flex-col items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                  <svg
                    className="h-8 w-8 animate-spin text-zinc-400"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeDasharray="32 24"
                    />
                  </svg>
                  <span>正在生成…</span>
                </div>
              )}
              {shareModalError && (
                <p className="text-center text-sm text-red-600 dark:text-red-400">{shareModalError}</p>
              )}
              {sharePreviewSrc && (
                // data URL 预览，不用 next/image
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={sharePreviewSrc}
                  alt="分享卡片预览"
                  className="max-h-[min(60vh,520px)] max-w-full select-none rounded-lg shadow-md"
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
              <button
                type="button"
                onClick={downloadShareImage}
                disabled={!sharePreviewSrc}
                className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                下载图片
              </button>
              {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
                <button
                  type="button"
                  onClick={() => void shareImageFromPreview()}
                  disabled={!sharePreviewSrc}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  系统分享…
                </button>
              )}
              <span className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyShareUrl(shareUrlRef.current)}
                  className="rounded-lg px-3 py-2 text-xs text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-400"
                >
                  复制文章链接
                </button>
                {copyLinkHint === "ok" && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">已复制</span>
                )}
                {copyLinkHint === "fail" && (
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    未能复制，请用弹窗里的链接或浏览器权限允许剪贴板
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
