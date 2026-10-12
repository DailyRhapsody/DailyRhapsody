/**
 * 封禁响应的契约测试。
 *
 * 背景：仓库原有的 35 个用例没有一条覆盖 proxy.ts 与 lib/blocked-page.ts，
 * 「35 个测试全过」证明不了这两个文件没坏。这里覆盖两件事：
 * 1. wantsHtml 的分类——页面导航拿 HTML、接口与子资源拿 JSON；
 * 2. blockedPageHtml 的产出——可访问性基线、noindex、以及不出现未替换的插值。
 *
 * 运行：node --experimental-test-module-mocks --test tests/blocked-response.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { blockedPageHtml, wantsHtml } from "../lib/blocked-page.ts";

function req(method, headers = {}) {
  const h = new Headers(headers);
  return { method, headers: h };
}

test("wantsHtml：浏览器导航拿 HTML", async (t) => {
  await t.test("Sec-Fetch-Dest: document", () => {
    assert.equal(wantsHtml(req("GET", { "sec-fetch-dest": "document" })), true);
  });
  await t.test("Sec-Fetch-Mode: navigate（无 dest）", () => {
    assert.equal(wantsHtml(req("GET", { "sec-fetch-mode": "navigate" })), true);
  });
  await t.test("只有 Accept: text/html", () => {
    assert.equal(wantsHtml(req("GET", { accept: "text/html,application/xhtml+xml" })), true);
  });
});

test("wantsHtml：接口与子资源拿 JSON", async (t) => {
  await t.test("无 Accept 无 Sec-Fetch", () => {
    assert.equal(wantsHtml(req("GET", {})), false);
  });
  await t.test("Accept: */*", () => {
    assert.equal(wantsHtml(req("GET", { accept: "*/*" })), false);
  });
  await t.test("Accept: application/json", () => {
    assert.equal(wantsHtml(req("GET", { accept: "application/json" })), false);
  });
  await t.test("图片子资源", () => {
    assert.equal(
      wantsHtml(req("GET", { accept: "image/avif,image/webp,*/*", "sec-fetch-dest": "image" })),
      false
    );
  });
  await t.test("非 GET 一律 false", () => {
    assert.equal(wantsHtml(req("POST", { accept: "text/html", "sec-fetch-mode": "navigate" })), false);
    assert.equal(wantsHtml(req("HEAD", { accept: "text/html", "sec-fetch-dest": "document" })), false);
  });
  await t.test("显式子资源 dest 压过 text/html", () => {
    assert.equal(
      wantsHtml(req("GET", { accept: "text/html", "sec-fetch-dest": "iframe" })),
      false
    );
  });
});

test("blockedPageHtml：产出契约", async (t) => {
  await t.test("可访问性基线与 noindex", () => {
    const html = blockedPageHtml(3600);
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /<main>/);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.match(html, /name="robots" content="noindex/);
    assert.match(html, /prefers-color-scheme: dark/);
  });

  await t.test("没有未替换的插值", () => {
    for (const s of [0, 754, 7200]) {
      assert.doesNotMatch(blockedPageHtml(s), /\$\{/);
    }
  });

  await t.test("文案随剩余时长变化", () => {
    assert.match(blockedPageHtml(0), /最长 24 小时后自动解除/);
    assert.match(blockedPageHtml(754), /约 13 分钟后自动解除/);
    assert.match(blockedPageHtml(7200), /约 2 小时后自动解除/);
    assert.match(blockedPageHtml(59), /约 1 分钟后自动解除/);
  });

  await t.test("不泄露封禁原因与内部键名", () => {
    const html = blockedPageHtml(3600);
    for (const leak of ["dr:blocked", "Auto-block", "violation", "honeypot", "Redis"]) {
      assert.ok(!html.includes(leak), `提示页不应出现 ${leak}`);
    }
  });
});
