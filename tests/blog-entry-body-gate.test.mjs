// node --experimental-test-module-mocks --test tests/blog-entry-body-gate.test.mjs
//
// 单篇文章页 /blog/[id] 的正文必须过门闸。
//
// 文章 id 不是秘密：思维大树的 public/tree/tree.json 与 v15-oak.html 的内嵌快照列着全部公开文章
// 的 id，静态文件不经过 proxy。页面本身不要求握手，正文一旦由服务端直出，脚本不握手就能按 id
// 逐篇取走全站正文。现在页面只输出标题、日期与标签，正文在握手后从 /api/diaries/[id] 读取。
// 这里守三件事：
//  1. 分享链接的落地页签发 dr_seed，否则直接打开链接的访客做不了握手，正文永远 403；
//  2. /api/diaries/[id] 没有 dr_gate 时拒绝；
//  3. 页面不直出正文，正文组件只拿到 id。
//
// 不配 Redis：限流与封禁在没有共享存储时直接放行，这里测的是门闸与种子本身。
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Next 运行时启动时会挂上这个全局；proxy 依赖链里的 next 模块在加载时要用到它
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "test-secret-at-least-16-chars";
for (const key of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) {
  delete process.env[key];
}

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/server") return next("next/server.js", context);
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
const { isGateIssuingPath } = await import("../lib/gate-pages.ts");
const { default: proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
hooks.deregister();

const ID = "34e9f71b-9bc2-8158-9425-ea65b783acd3";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** 在聊天软件里点开分享链接：顶层导航，没有任何本站 cookie */
const openSharedLink = {
  "user-agent": CHROME,
  accept: "text/html,application/xhtml+xml",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

test("isGateIssuingPath：单篇文章页只认 Notion 页面 id", () => {
  for (const path of [`/blog/${ID}`, `/blog/${ID.replace(/-/g, "")}`, `/blog/${ID.toUpperCase()}`]) {
    assert.equal(isGateIssuingPath(path), true, path);
  }
  for (const path of ["/blog/abc", `/blog/${ID}x`, `/blog/${ID}/opengraph-image`, "/blog/", "/blogx"]) {
    assert.equal(isGateIssuingPath(path), false, path);
  }
  for (const path of ["/", "/blog", "/moments", "/about", "/reference"]) {
    assert.equal(isGateIssuingPath(path), true, path);
  }
});

test("从分享链接直接打开单篇页：proxy 签发 dr_seed，且不缓存、不收录", async () => {
  const res = await proxy(new NextRequest(`https://tengjun.org/blog/${ID}`, { headers: openSharedLink }));
  assert.match(res.headers.get("set-cookie") ?? "", /(?:^|,\s*)dr_seed=/);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
});

test("不是文章 id 的路径不签发种子", async () => {
  const res = await proxy(new NextRequest("https://tengjun.org/blog/abc", { headers: openSharedLink }));
  assert.doesNotMatch(res.headers.get("set-cookie") ?? "", /dr_seed=/);
});

test("正文接口没有 dr_gate 时拒绝", async () => {
  const res = await proxy(
    new NextRequest(`https://tengjun.org/api/diaries/${ID}`, {
      headers: {
        "user-agent": CHROME,
        accept: "application/json",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        referer: `https://tengjun.org/blog/${ID}`,
      },
    })
  );
  assert.equal(res.status, 403);
});

test("页面不直出正文，正文组件只拿到 id", () => {
  const page = fs.readFileSync("app/(detail)/blog/[id]/page.tsx", "utf8");
  const pageBody = page.slice(page.indexOf("export default async function BlogEntryPage"));
  assert.ok(pageBody.length > 0 && pageBody.length < page.length, "找不到页面组件");
  // 页面组件里不读正文（标题与摘要在上面的 titleOf / descriptionOf 里取，只进标题与 meta）
  assert.doesNotMatch(pageBody, /\.summary\b/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  // 正文组件只拿 id：任何别的 prop 都会随 RSC 数据进 HTML
  assert.match(pageBody, /<BlogEntryBody id=\{item\.id\} \/>/);

  const body = fs.readFileSync("app/(detail)/blog/[id]/BlogEntryBody.tsx", "utf8");
  assert.match(body, /^"use client";/);
  // 走 fetchWithTimeout：握手未完成时的 403 会等 dr-gate-ready 后重试
  assert.match(body, /fetchWithTimeout\(`\/api\/diaries\/\$\{encodeURIComponent\(id\)\}`/);
});
