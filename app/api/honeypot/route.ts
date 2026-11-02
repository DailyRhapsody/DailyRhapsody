import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { blockIp } from "@/lib/honeypot";
import { isCrossSiteInduced } from "@/lib/fetch-metadata";
import { getClientIpFromRequest } from "@/lib/client-ip";
import { verifyAdminCookieValue } from "@/lib/auth";
import {
  isLegitLinkPreviewBot,
  isLegitRssClient,
  isLegitSearchBot,
  withAntiScrapeHeaders,
} from "@/lib/request-guard";

/**
 * 防爬蜜罐：页面上有一个肉眼不可见的链接指向这里，正常人类不会点到，
 * 顺着 DOM 抓链接的爬虫会撞上——撞上即封 IP 24 小时。
 *
 * 三条历史教训（2026-08 修复）：
 * 1. IP 必须走 lib/client-ip.ts 的可信代理链。旧实现直接读 x-forwarded-for
 *    第一段，攻击者可以伪造该头把任意 IP（包括站主自己）封 24 小时，
 *    也可以栽赃搜索引擎出口 IP。
 * 2. 合法搜索引擎/RSS/链接预览 bot 不能封。全站响应已带 X-Robots-Tag:
 *    noindex, nofollow（lib/http-security.ts），layout 的 rel="nofollow"
 *    是第二层提示——守规矩的 Googlebot 不会追这个链接；UA 白名单是给
 *    不吃这两层提示的预览类 bot 的兜底，只拒绝不封禁。UA 可伪造，但伪造者
 *    最多免于「即时封禁」，仍受全局限流与违规累计约束。
 * 3. 本路径已纳入 proxy.ts matcher：bot 类 UA（curl/python/headless）会在
 *    middleware 就被 403 + 记违规（4 次/10min 才封），到不了这里；能走到
 *    这里的是伪装浏览器 UA 的爬虫，撞上即封。
 *
 * admin 豁免：站主自己（或登录态下误触）不封自己的 IP——被封虽不影响
 * admin 会话本身，但会殃及同一出口 IP 的其他访客。
 *
 * 4. 跨站诱导（2026-11 修复）：第三方页面放一张 `<img src="…/api/honeypot">`，或用
 *    跳转、iframe 把访客送到这里，浏览器会带着真实 UA 发请求；SameSite=Lax 的站长 cookie
 *    不随跨站子资源发送，admin 豁免也失效。这类请求只拒绝、不封禁，判据见
 *    lib/fetch-metadata.ts。顺着本站 DOM 抓链接的爬虫发的是同源请求，照旧撞上即封。
 */
export async function GET(req: Request) {
  const ip = getClientIpFromRequest(req);
  const ua = req.headers.get("user-agent");

  const adminCookie = (await cookies()).get("admin_session")?.value;
  const isAdmin = !!(adminCookie && verifyAdminCookieValue(adminCookie));

  const isWhitelisted =
    isAdmin ||
    isLegitSearchBot(ua) || isLegitRssClient(ua) || isLegitLinkPreviewBot(ua);

  if (!isWhitelisted && !isCrossSiteInduced(req.headers)) {
    await blockIp(ip, `Visited honeypot. UA: ${ua}`);
  }

  return withAntiScrapeHeaders(
    NextResponse.json({ error: "Access denied" }, { status: 403 })
  );
}
