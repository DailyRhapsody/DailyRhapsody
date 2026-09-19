import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AnalyticsCollector } from "@/components/AnalyticsCollector";
import { GateClient } from "@/components/GateClient";
import { PetLauncher } from "@/components/pet/PetLauncher";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tengjun.org";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "DailyRhapsody",
  description: "I think, therefore I am.",
};

// 关键：禁止 Next.js / Vercel CDN 预渲染缓存任何页面响应。
// 原因：middleware (proxy.ts) attachSeed 给 /, /blog, /moments, /about
// 下发 dr_seed cookie，并明确 Cache-Control: no-store。但若页面本身被
// 预渲染（x-vercel-cache: HIT, x-nextjs-prerender: 1），CDN 会直接返回
// 缓存的 HTML，**根本不调用 middleware** → 真人拿不到 dr_seed →
// PoW 跑不通 → /api/diaries 永远 403 → 4 次后自封。
//
// force-dynamic 强制每次请求都跑 middleware，让 attachSeed 可以下发新鲜
// 的、绑当前 IP 的 dr_seed。性能影响可控：内容来自 Notion 的 SWR 内存层，
// 不增加上游 API 调用。
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <GateClient />
        <AnalyticsCollector />
        <PetLauncher />
        {/* Anti-Scrape Honeypot。rel=nofollow 让守规矩的搜索引擎不追这个链接
            （追了也只会被 route 的 UA 白名单拒绝而非封禁，双保险） */}
        <a
          href="/api/honeypot"
          aria-hidden="true"
          tabIndex={-1}
          rel="nofollow"
          style={{ position: 'absolute', top: -100, left: -100, width: 1, height: 1, overflow: 'hidden', opacity: 0 }}
        >
          DailyRhapsody Feed
        </a>
      </body>
    </html>
  );
}
