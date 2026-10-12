"use client";

import { useEffect, useRef, useState } from "react";

// 关于页整屏嵌入 Notion「主页」。
//
// 1) 为什么用 /ebd/：Notion 公共页回 X-Frame-Options: SAMEORIGIN，且 CSP
//    frame-ancestors 只允许 'self' 与 app.notion.com，直接嵌会被浏览器拒绝。
//    /ebd/ 是 Notion 给自家「Embed」块用的端点，CSP 放宽为 frame-ancestors https: http:，
//    也不再下发 X-Frame-Options，因此可以跨站整屏嵌入。**该端点没有任何官方文档承诺**，
//    属显式依赖，不是稳定接口。
// 2) 为什么要上移：iframe 里 Notion 自带的顶栏 .notion-topbar 实测高度 44px、贴顶固定，
//    跨域删不掉，只能把 iframe 整体上移一个顶栏高度让它落到视口之外；高度同步 +44px，
//    保证底部不被截断。Notion 改版后这里会静默露出一条顶栏。
// 3) 失败兜底：嵌入是否仍然成立由 /api/about-embed 在服务端读响应头判定
//    （XFO 与 frame-ancestors 浏览器侧读不到），判定失败或探测请求本身失败时，
//    覆盖一层最简提示与跳转链接，避免访客看到整页空白。
const NOTION_PAGE_URL =
  "https://dailyrhapsody.notion.site/3f29f71b9bc28098a321e822d69e963f";
const NOTION_EMBED_URL =
  "https://dailyrhapsody.notion.site/ebd/3f29f71b9bc28098a321e822d69e963f";

const TOPBAR_H = 44;

export default function AboutPage() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/about-embed")
      .then((r) => r.json())
      .then((d: { ok?: boolean }) => {
        if (!cancelled && d.ok !== true) setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <iframe
        ref={frameRef}
        src={NOTION_EMBED_URL}
        title="主页"
        referrerPolicy="no-referrer"
        className="fixed left-0 w-full border-0"
        style={{ top: -TOPBAR_H, height: `calc(100% + ${TOPBAR_H}px)` }}
      />
      {failed && (
        <div className="fixed inset-0 flex items-center justify-center bg-white px-6 dark:bg-zinc-950">
          <div className="max-w-sm text-center">
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              页面内容没能加载出来。
            </p>
            <a
              href={NOTION_PAGE_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-sm text-blue-600 transition-opacity hover:opacity-80 dark:text-blue-400"
            >
              在 Notion 中打开 ↗
            </a>
          </div>
        </div>
      )}
    </>
  );
}
