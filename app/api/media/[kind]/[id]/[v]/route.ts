/**
 * Notion 托管图片 / 视频的代理：/api/media/{kind}/{id}/{v}
 *
 * 缓存与页面里只存这个稳定路径（lib/notion-media.ts），请求时换成当前有效的签名地址：
 *  - 图片：流式转发字节（next/image 优化器与 <img> 都能用）
 *  - 视频：302 到签名地址，Range 请求直接打到 S3，函数不转发大文件
 *
 * 鉴权：请求路径必须与当前缓存里某篇日记 / moment 实际引用的路径完全一致（含版本号 v），
 * 只要有一处公开即可；仅私密引用时只有管理员能取。其他数据库的文件、随机 id、随意改 v
 * 一律 404。归属只读缓存，不触发 Notion 抓取；缓存缺失返回 503。
 *
 * 公开图片只缓存 5 分钟：文章在 Notion 改成私密后，图片也要尽快对外失效。
 * 旧的 /api/media?block= 已删除：仓库里没有调用方，且不校验文件是否属于公开内容。
 */

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import { getCachedDiaries, resolveNotionFileUrl } from "@/lib/notion";
import { mediaPathPrefix, type MediaKind } from "@/lib/notion-media";
import { getCachedMoments } from "@/lib/notion-moments";
import { limitByIp } from "@/lib/upstash-rate-limit";

const PUBLIC_CACHE = "public, max-age=300, s-maxage=300";
const PRIVATE_CACHE = "private, no-store";

function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": PRIVATE_CACHE } });
}

type Visibility = "public" | "private" | "unknown" | "no-cache";

async function lookupVisibility(kind: MediaKind, id: string, v: string): Promise<Visibility> {
  const path = `${mediaPathPrefix(kind, id)}${v}`;
  const diaries = await getCachedDiaries();
  const moments = kind === "b" ? await getCachedMoments() : [];
  if (!diaries && !moments) return "no-cache";

  let found = false;
  for (const d of diaries ?? []) {
    const hit = kind === "p" ? (d.images ?? []).includes(path) : d.summary.includes(path);
    if (!hit) continue;
    if (d.isPublic !== false) return "public";
    found = true;
  }
  for (const m of moments ?? []) {
    if (!m.media.some((x) => x.url === path || x.thumbUrl === path)) continue;
    if (m.isPublic) return "public";
    found = true;
  }
  return found ? "private" : "unknown";
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ kind: string; id: string; v: string }> }
) {
  const { kind, id, v } = await params;
  if ((kind !== "b" && kind !== "p") || !/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{10}$/.test(v)) {
    return jsonError(404, "Not found");
  }

  // 一页图片多，额度放宽；只挡脚本刷随机路径
  if (!(await limitByIp("media", getClientIpFromRequest(req), 300, "1 m"))) {
    return jsonError(429, "Too many requests");
  }

  const visibility = await lookupVisibility(kind, id, v);
  if (visibility === "no-cache") return jsonError(503, "Cache warming up");
  if (visibility === "unknown") return jsonError(404, "Not found");
  if (visibility === "private" && !(await isAdmin())) return jsonError(404, "Not found");
  const cacheControl = visibility === "public" ? PUBLIC_CACHE : PRIVATE_CACHE;

  let ref = await resolveNotionFileUrl(kind, id, v);
  if (!ref) return jsonError(404, "Not found");

  if (ref.media === "video") {
    const res = NextResponse.redirect(ref.url, 302);
    // 跳转目标是临时签名地址，不进 CDN
    res.headers.set("Cache-Control", "private, max-age=60");
    return res;
  }

  let upstream = await fetch(ref.url).catch(() => null);
  if (upstream && !upstream.ok && ref.fromCache) {
    // 缓存的签名地址提前失效：强制换签再试一次
    ref = await resolveNotionFileUrl(kind, id, v, { refresh: true });
    if (!ref) return jsonError(404, "Not found");
    upstream = await fetch(ref.url).catch(() => null);
  }
  if (!upstream || !upstream.ok || !upstream.body) {
    return jsonError(502, "Upstream fetch failed");
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return jsonError(502, "Unsupported media type");
  }

  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    // 用户上传的 SVG 若被直接打开，不允许在本站源下执行脚本
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  return new NextResponse(upstream.body, { status: 200, headers });
}
