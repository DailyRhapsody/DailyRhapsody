// node --experimental-test-module-mocks --test tests/gate-slow-handshake.test.mjs
//
// 慢握手（冷启动、慢网）：POST /api/gate/issue 迟迟不返回时，受保护请求应等握手完成后拿到 200，
// 握手放弃的时间不早于数据请求自己的 30 秒预算；全程不计违规。
//  - 9 秒：超过 main 上 fetchWithTimeout 等握手的 8 秒上限（V3 对 #199 的补漏项）。
//  - 12 秒：超过握手请求若设 10 秒超时的上限。浏览器中止了 POST 而服务端照常兑换 seed 时，
//    浏览器拿不到 dr_gate、却留着用过的 seed，随后刷新会撞「replay nonce」计违规，因此另测一次刷新。
// 时钟用 node:test mock timers（setTimeout 与 Date），不等真实时间。
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test } from "node:test";
import {
  Tab,
  advanceUntil,
  createRedisStore,
  fastSubtleDigest,
  loadServer,
  registerProjectHooks,
  setupEnv,
} from "./helpers/gate-browser.mjs";

setupEnv();
const hooks = registerProjectHooks();
const ID = "00000000-0000-4000-8000-000000000000";
const issued = (tab) =>
  tab.count((r) => r.method === "POST" && r.path === "/api/gate/issue" && r.status === 200);

test("慢握手：受保护请求等到握手完成，不计违规", async (t) => {
  const store = createRedisStore();
  t.mock.module("@upstash/redis", { namedExports: { Redis: store.Redis } });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-03T08:00:00Z") });
  fastSubtleDigest(t);
  const connect = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("real network is forbidden in this test");
  });
  t.after(() => {
    hooks.deregister();
    assert.equal(connect.mock.callCount(), 0);
  });
  const server = await loadServer();
  const handle = server.handle;
  let issueDelayMs = 0;
  let serverIdle = Promise.resolve();
  server.handle = async (method, path, headers, body) => {
    if (!(issueDelayMs && method === "POST" && path === "/api/gate/issue")) return handle(method, path, headers, body);
    const ms = issueDelayMs;
    issueDelayMs = 0;
    let idle;
    serverIdle = new Promise((r) => (idle = r));
    await new Promise((r) => setTimeout(r, ms));
    try {
      return await handle(method, path, headers, body);
    } finally {
      idle();
    }
  };

  /** 首访单篇页：正文请求 + 根布局的 GateClient；握手的 POST 推迟 delayMs 返回 */
  async function openEntry(tab, delayMs) {
    issueDelayMs = delayMs;
    const page = await tab.navigate(`/blog/${ID}`, { reload: true });
    const body = page.fetch(`/api/diaries/${ID}`);
    page.mountGate();
    return advanceUntil(t, body);
  }

  await t.test("握手 POST 9 秒：正文 200，只握手一次，不计违规", async () => {
    const ip = "203.0.113.70";
    const tab = new Tab(server, ip);
    const { value: res, elapsed } = await openEntry(tab, 9_000);
    assert.equal(res.status, 200, "正文请求应在握手完成后成功");
    assert.ok(elapsed >= 9_000, `应等到握手完成（实际 ${elapsed}ms）`);
    assert.equal(store.violTotal(ip), 0);
    assert.equal(issued(tab), 1, "只握手一次");
  });

  const ip = "203.0.113.71";
  const tab = new Tab(server, ip);

  await t.test("握手 POST 12 秒：正文 200，不计违规", async () => {
    const { value: res } = await openEntry(tab, 12_000);
    assert.equal(res.status, 200, "握手请求不应早于数据请求的 30 秒预算放弃");
    assert.equal(store.violTotal(ip), 0);
    assert.equal(issued(tab), 1);
  });

  await t.test("随后刷新：不计违规", async () => {
    await advanceUntil(t, serverIdle); // 服务端那次 POST 处理完（seed 已兑换）
    const { value: res } = await openEntry(tab, 0);
    assert.equal(res.status, 200);
    assert.equal(store.violTotal(ip), 0, "刷新后不应因重放已兑换的 seed 计违规");
  });
});
