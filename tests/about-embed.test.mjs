/**
 * 嵌入可用性判定的分类测试。
 *
 * 用真实网络结果做断言的前提不成立：Notion / Cloudflare 在连续请求下返回 429，
 * 而 429 响应自带 `X-Frame-Options: SAMEORIGIN`，会把限流误判成「端点已收口」。
 * 这里固定输入 status 与两个响应头，覆盖真实观测到的几种组合。
 *
 * 运行：node --experimental-test-module-mocks --test tests/about-embed.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isEmbeddable } from "../lib/about-embed.ts";

// 2026-10-12 实测：/ebd/ 在未被限流时不下发 XFO，frame-ancestors 放宽为 https: http:
const EBD_ALLOW = "frame-src 'self' https:;frame-ancestors https: http:;worker-src 'self'";
// 2026-10-12 实测：普通公共页下发 SAMEORIGIN，frame-ancestors 只允许 self 与 app.notion.com
const PLAIN_DENY = "frame-ancestors 'self' https://app.notion.com notion://app.notion.com";
// 2026-10-12 实测：被 Cloudflare 限流时的 429 响应
const RATE_LIMITED_CSP = "frame-ancestors 'self' https://app.notion.com";

test("isEmbeddable：可嵌入", async (t) => {
  await t.test("200 且无 XFO、frame-ancestors 放行方案源", () => {
    assert.equal(isEmbeddable(200, null, EBD_ALLOW), true);
  });
  await t.test("200 且无 XFO、CSP 无 frame-ancestors 指令", () => {
    assert.equal(isEmbeddable(200, null, "default-src 'self'; script-src 'self'"), true);
  });
  await t.test("200 且无 XFO、CSP 为空", () => {
    assert.equal(isEmbeddable(200, null, ""), true);
  });
  await t.test("frame-ancestors 通配", () => {
    assert.equal(isEmbeddable(200, null, "frame-ancestors *"), true);
  });
});

test("isEmbeddable：不可嵌入", async (t) => {
  await t.test("下发 X-Frame-Options（普通公共页）", () => {
    assert.equal(isEmbeddable(200, "SAMEORIGIN", PLAIN_DENY), false);
  });
  await t.test("Cloudflare 429 限流", () => {
    assert.equal(isEmbeddable(429, "SAMEORIGIN", RATE_LIMITED_CSP), false);
  });
  await t.test("429 即使不带 XFO 也判不可用", () => {
    assert.equal(isEmbeddable(429, null, EBD_ALLOW), false);
  });
  await t.test("5xx", () => {
    assert.equal(isEmbeddable(503, null, EBD_ALLOW), false);
  });
  await t.test("frame-ancestors 只允许 self", () => {
    assert.equal(isEmbeddable(200, null, "frame-ancestors 'self'"), false);
  });
  await t.test("frame-ancestors 只允许具体第三方域", () => {
    assert.equal(
      isEmbeddable(200, null, "frame-ancestors 'self' https://app.notion.com"),
      false
    );
  });
});
