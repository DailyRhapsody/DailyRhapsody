// node --test tests/blog-entry-matcher.test.mjs
//
// 单篇文章页 /blog/[id] 必须经过 proxy：它服务端渲染整篇正文，不在 matcher 里就吃不到
// IP 黑名单与全局限流。旧 matcher 只有精确的 "/blog"，不匹配 "/blog/<id>"。
//
// 用 Next 自带的 unstable_doesMiddlewareMatch 判定，走的是运行时同一套 matcher 编译逻辑，
// 不自己拼正则。
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";

// Next 运行时启动时会挂上这个全局；proxy 依赖链里的 next 模块在加载时要用到它
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;

const require = createRequire(import.meta.url);
const { unstable_doesMiddlewareMatch } = require("next/experimental/testing/server");

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/server") return next("next/server.js", context);
    // 只需要 config，用不到请求上下文；真实的 next/headers 在测试进程里会因缺少 AsyncLocalStorage 报错
    if (specifier === "next/headers") return { url: "mock:next-headers", shortCircuit: true, format: "module" };
    return next(
      specifier.startsWith("@/")
        ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href
        : specifier,
      context
    );
  },
  load(url, context, next) {
    if (url === "mock:next-headers") {
      return { format: "module", shortCircuit: true, source: "export async function cookies() { return { get() {} }; }" };
    }
    return next(url, context);
  },
});
const { config } = await import("../proxy.ts");
hooks.deregister();

const matches = (url) => unstable_doesMiddlewareMatch({ config, url });

test("单篇文章页经过 proxy", () => {
  assert.equal(matches("/blog/34e9f71b-9bc2-8158-9425-ea65b783acd3"), true);
  assert.equal(matches("/blog/34e9f71b9bc281589425ea65b783acd3"), true);
});

test("原有页面与接口仍然经过 proxy", () => {
  for (const url of ["/", "/blog", "/moments", "/about", "/reference", "/reference/abc", "/api/diaries", "/api/diaries/abc", "/api/honeypot", "/admin"]) {
    assert.equal(matches(url), true, url);
  }
});

test("静态资源不进 proxy", () => {
  for (const url of ["/tree/v15-oak.html", "/favicon.ico", "/_next/static/chunks/main.js"]) {
    assert.equal(matches(url), false, url);
  }
});
