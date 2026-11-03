import { getAllowedHostnames } from "@/lib/site-hosts";

/**
 * 这次请求是不是第三方页面借访客的浏览器发出的（跨站子资源、跨站跳转、跨站表单）。
 *
 * 违规计数与封禁打的是出口 IP，而浏览器会替任何网页发请求：第三方页面放一张
 * `<img src="https://tengjun.org/api/honeypot">`，或者对受保护接口连放几张图，访客的浏览器
 * 就会带着真实 UA 打过来；SameSite=Lax 的 admin_session / dr_gate / dr_seed 不随跨站子资源
 * 发送，站长豁免与门闸都认不出这是真人。这类请求要照常拒绝，但不能记违规、更不能封 IP，
 * 否则任何人都能把任意访客（包括站长自己）的出口封 24 小时。
 *
 * 只在浏览器明确表明「来自别的站」时返回 true：
 *  - `Sec-Fetch-Site: cross-site / same-site`（Chrome、Firefox、Safari 16.4+ 都会发）；
 *  - 不发 Fetch Metadata 的旧浏览器：`Origin` 或 `Referer` 指向白名单之外的主机，
 *    或者 `Accept` 以 `image/` 开头（`<img>` 子资源；顺着链接抓页面的爬虫不会这样请求）。
 * curl、requests、scrapy 默认不带这些头，照旧计违规。手工伪造 cross-site 的脚本免于记违规，
 * 全局限流也只扣它那份跨站额度（proxy.ts，交替声明最多拿到两份）；受保护接口仍要门闸凭据。
 */
export function isCrossSiteInduced(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site" || site === "same-site") return true;
  // same-origin：本站页面发出；none：用户或脚本直接访问。两者都不是第三方诱导。
  if (site) return false;
  return (
    isForeign(headers.get("origin")) ||
    isForeign(headers.get("referer")) ||
    /^image\//i.test(headers.get("accept")?.trim() ?? "")
  );
}

/**
 * Origin / Referer 指向白名单之外的主机。`Origin: null` 是不透明来源（沙箱 iframe、跨站重定向），
 * 本站页面不会发出，按外站处理；缺失或畸形的值不算证据。
 */
function isForeign(value: string | null): boolean {
  if (!value) return false;
  if (value.trim() === "null") return true;
  try {
    return !getAllowedHostnames().has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}
