"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  LANG_COOKIE,
  LANG_COOKIE_MAX_AGE,
  t as translate,
  type Lang,
} from "@/lib/i18n";

type LangContextValue = {
  lang: Lang;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLang: (next: Lang) => void;
};

const LangContext = createContext<LangContextValue | null>(null);

function writeLangCookie(lang: Lang) {
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=${LANG_COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * 语言上下文。lang 由服务端（cookie / Accept-Language）算好后传入；
 * 首访时客户端把同一个值固化成 cookie，后续请求就稳定了。
 * 切换语言写 cookie 后 router.refresh()，让服务端组件一起换语言。
 */
export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    if (!document.cookie.includes(`${LANG_COOKIE}=`)) writeLangCookie(lang);
  }, [lang]);

  const value = useMemo<LangContextValue>(
    () => ({
      lang,
      t: (key, vars) => translate(lang, key, vars),
      setLang: (next) => {
        if (next === lang) return;
        writeLangCookie(next);
        router.refresh();
      },
    }),
    [lang, router],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const value = useContext(LangContext);
  if (!value) {
    // 没被 Provider 包住的组件（如局部测试）回落到中文，不抛错打断渲染。
    return { lang: "zh", t: (key, vars) => translate("zh", key, vars), setLang: () => {} };
  }
  return value;
}
