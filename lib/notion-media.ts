/**
 * Notion 托管文件（直接上传到 Notion 的图片 / 视频）的签名地址 1 小时过期，
 * 而日记与 moments 的列表缓存保留 48 小时：缓存里存签名地址，刷新约一小时后
 * 正文图片全部 403、卡片缩略图经 /_next/image 返回 502。
 *
 * 缓存与页面里只存站内稳定路径 /api/media/{kind}/{id}/{v}，由代理路由按需换签：
 *  - kind: b = 正文 block（image / video），p = 页面 Image 属性
 *  - id:   去掉连字符的 Notion block / page id
 *  - v:    S3 文件路径（不含签名参数）的哈希。重新签名不变、换图才变，所以可以长缓存
 *
 * 外链图片（type=external）不会过期，保持原地址，不走代理。
 */
import { createHash } from "crypto";

export type MediaKind = "b" | "p";

export function mediaPathPrefix(kind: MediaKind, id: string): string {
  return `/api/media/${kind}/${id.replace(/-/g, "")}/`;
}

/** 同一文件重新签名版本号不变，换了文件才变。 */
export function mediaVersion(signedUrl: string): string {
  let stable = signedUrl;
  try {
    const u = new URL(signedUrl);
    stable = u.origin + u.pathname;
  } catch {
    // 不是合法 URL 时直接用原串算版本号
  }
  return createHash("sha1").update(stable).digest("hex").slice(0, 10);
}

export function mediaProxyPath(kind: MediaKind, id: string, signedUrl: string): string {
  return `${mediaPathPrefix(kind, id)}${mediaVersion(signedUrl)}`;
}
