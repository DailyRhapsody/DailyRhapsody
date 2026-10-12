import { NextResponse } from "next/server";
import { isEmbeddable } from "@/lib/about-embed";

/**
 * 探测 Notion 的嵌入端点当前是否仍可被本站 iframe 使用。
 *
 * 为什么必须在服务端做：`X-Frame-Options` 与 CSP 的 `frame-ancestors` 只在响应头里，
 * 跨域 iframe 在浏览器侧读不到，客户端任何「帧内是否为空」的推断都不可靠
 * （实测 Notion 公共页的子帧数量会波动，正常加载时 window.length 也可能是 0）。
 *
 * 这个路由同时充当哨兵：/ebd/ 是 Notion 未公开的实现细节，一旦它被收口，
 * 这里会转成 ok:false，关于页据此展示兜底，不至于让人看到空白页。
 */
const EMBED_URL =
  "https://dailyrhapsody.notion.site/ebd/3f29f71b9bc28098a321e822d69e963f";

const TTL_MS = 60 * 60 * 1000;

let cached: { at: number; ok: boolean } | null = null;

async function probeEmbeddable(): Promise<boolean> {
  try {
    const res = await fetch(EMBED_URL, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; DailyRhapsody-embed-check)" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    return isEmbeddable(
      res.status,
      res.headers.get("x-frame-options"),
      res.headers.get("content-security-policy") ?? ""
    );
  } catch {
    return false;
  }
}

export async function GET() {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    cached = { at: Date.now(), ok: await probeEmbeddable() };
  }
  return NextResponse.json(
    { ok: cached.ok },
    { headers: { "Cache-Control": "public, max-age=3600, s-maxage=3600" } }
  );
}
