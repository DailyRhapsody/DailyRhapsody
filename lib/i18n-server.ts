import { cookies, headers } from "next/headers";
import { LANG_COOKIE, detectLangFromAcceptLanguage, isLang, type Lang } from "@/lib/i18n";

/** 英文样式暂时关闭：先固定中文，恢复时改回 true 即可。 */
const EN_ENABLED = false;

/**
 * 服务端语言判定：英文层暂时停用时固定返回中文。
 * 恢复英文时，保留下面的 cookie / Accept-Language 逻辑。
 */
export async function getLang(): Promise<Lang> {
  if (!EN_ENABLED) return "zh";
  const store = await cookies();
  const fromCookie = store.get(LANG_COOKIE)?.value;
  if (isLang(fromCookie)) return fromCookie;
  const requestHeaders = await headers();
  return detectLangFromAcceptLanguage(requestHeaders.get("accept-language"));
}
