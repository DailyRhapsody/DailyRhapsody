import { cookies, headers } from "next/headers";
import { LANG_COOKIE, detectLangFromAcceptLanguage, isLang, type Lang } from "@/lib/i18n";

/**
 * 服务端语言判定：cookie 优先，没有 cookie 时按本次请求的 Accept-Language。
 * 首次访问由客户端把判定结果写成 cookie（见 components/LangProvider.tsx），
 * 之后服务端渲染与客户端渲染用同一份值，避免首屏闪烁。
 */
export async function getLang(): Promise<Lang> {
  const store = await cookies();
  const fromCookie = store.get(LANG_COOKIE)?.value;
  if (isLang(fromCookie)) return fromCookie;
  const requestHeaders = await headers();
  return detectLangFromAcceptLanguage(requestHeaders.get("accept-language"));
}
