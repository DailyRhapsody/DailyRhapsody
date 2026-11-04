// node --experimental-test-module-mocks --test tests/gate-expiry.test.mjs
//
// V2-4：读者握手后把标签页挂了两天，dr_gate（HttpOnly，48h）已被浏览器丢弃，标签页里的
// 「已握手」判断却还在。期望：客户端重新握手、拿到数据；过期这件事本身不给读者记违规。
//
// 真实模块：proxy.ts、/api/gate/issue、/api/gate/seed、lib/honeypot、lib/scrape-gate、
// @upstash/ratelimit、lib/fetch-with-timeout、components/GateClient.tsx、
// lib/gate-handshake.ts。替身只在边界：Redis（内存）、时钟（只冻结并拨动 Date）、浏览器全局，
// 见 helpers/gate-browser.mjs。
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test } from "node:test";
import {
  HOUR,
  Tab,
  createRedisStore,
  fastSubtleDigest,
  loadServer,
  registerProjectHooks,
  setupEnv,
} from "./helpers/gate-browser.mjs";

setupEnv();
const hooks = registerProjectHooks();

const FIRST_SCREEN = [
  "/api/diaries?limit=30&offset=0&outline=1",
  "/api/moments?limit=8&offset=0&outline=1",
  "/api/profile",
];
const issued = (tab) =>
  tab.count((r) => r.method === "POST" && r.path === "/api/gate/issue" && r.status === 200);

test("V2-4：dr_gate 过期后仍在用的标签页", async (t) => {
  const store = createRedisStore();
  t.mock.module("@upstash/redis", { namedExports: { Redis: store.Redis } });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-03T08:00:00Z") });
  fastSubtleDigest(t);
  const connect = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("real network is forbidden in this test");
  });
  t.after(() => {
    hooks.deregister();
    assert.equal(connect.mock.callCount(), 0);
  });
  const server = await loadServer();

  /** 打开 /blog（首屏请求 + 根布局的 GateClient），首屏拿到数据后标签页挂起 48h + 1min */
  async function openThenSuspend(ip) {
    const tab = new Tab(server, ip);
    const page = await tab.navigate("/blog", { reload: true });
    const first = page.fetch(FIRST_SCREEN[0]);
    page.mountGate();
    assert.equal((await first).status, 200, "前置：首访首屏拿到数据");
    assert.equal(issued(tab), 1, "前置：握手一次");
    t.mock.timers.tick(48 * HOUR + 60_000);
    assert.equal(tab.jar.has("dr_gate"), false, "前置：浏览器已按 Max-Age 丢弃 dr_gate");
    return { tab, page };
  }

  await t.test("不刷新继续翻页：重新握手后拿到下一页", async () => {
    const { tab, page } = await openThenSuspend("203.0.113.11");
    const res = await page.fetch("/api/diaries?limit=30&offset=30");
    assert.equal(res.status, 200, "翻页请求最终应成功");
    assert.equal(issued(tab), 2, "应重新握手一次");
  });

  await t.test("不刷新继续翻页：不计违规，IP 不被封", async () => {
    const ip = "203.0.113.12";
    const { page } = await openThenSuspend(ip);
    await page.fetch("/api/diaries?limit=30&offset=30");
    assert.equal(store.violTotal(ip), 0, "过期凭据的读者不应被记违规");
    assert.equal(store.isBlocked(ip), false);
  });

  await t.test("刷新后：重新握手，首屏拿到数据（不再一直「暂无文章」）", async () => {
    const { tab } = await openThenSuspend("203.0.113.13");
    const page = await tab.navigate("/blog", { reload: true });
    const first = page.fetch(FIRST_SCREEN[0]);
    page.mountGate();
    assert.equal((await first).status, 200);
    assert.equal(issued(tab), 2);
  });

  await t.test("客户端跳转回列表：首屏 3 个受保护请求并发，全部成功且不计违规", async () => {
    const ip = "203.0.113.14";
    const { tab, page } = await openThenSuspend(ip);
    tab.softNavigate("/blog");
    const statuses = (await Promise.all(FIRST_SCREEN.map((u) => page.fetch(u)))).map((r) => r.status);
    assert.deepEqual(statuses, [200, 200, 200]);
    assert.equal(store.violTotal(ip), 0);
    assert.equal(issued(tab), 2, "并发 403 只触发一次握手");
  });

  // 以下两条是护栏（main 上本来就成立）：修复不能退化成「每次进页面都重新做 PoW」，也不能让首访记违规
  await t.test("护栏：凭据有效时刷新不重新握手", async () => {
    const tab = new Tab(server, "203.0.113.15");
    let page = await tab.navigate("/blog", { reload: true });
    const first = page.fetch(FIRST_SCREEN[0]);
    page.mountGate();
    assert.equal((await first).status, 200);
    t.mock.timers.tick(HOUR);
    page = await tab.navigate("/blog", { reload: true });
    const again = page.fetch(FIRST_SCREEN[0]);
    page.mountGate();
    assert.equal((await again).status, 200);
    assert.equal(issued(tab), 1);
  });

  await t.test("护栏：新访客首访，首屏并发请求全部成功且不计违规", async () => {
    const ip = "203.0.113.16";
    const tab = new Tab(server, ip);
    const page = await tab.navigate("/blog", { reload: true });
    const pending = FIRST_SCREEN.map((u) => page.fetch(u));
    page.mountGate();
    assert.deepEqual((await Promise.all(pending)).map((r) => r.status), [200, 200, 200]);
    assert.equal(store.violTotal(ip), 0);
    assert.equal(issued(tab), 1);
  });

  // 兜底路径：提示说凭据有效、服务端却不认（AUTH_SECRET 轮换、dr_gate 被单独删掉）
  await t.test("提示在、dr_gate 已失效时刷新：403 后作废提示、重新握手、重试拿到 200，不计违规", async () => {
    const ip = "203.0.113.17";
    const tab = new Tab(server, ip);
    let page = await tab.navigate("/blog", { reload: true });
    let first = page.fetch(FIRST_SCREEN[0]);
    page.mountGate();
    assert.equal((await first).status, 200, "前置：首访首屏拿到数据");
    tab.jar.map.delete("dr_gate");
    assert.equal(tab.jar.has("dr_gate_hint"), true, "前置：提示仍在");
    const before = tab.log.length;
    page = await tab.navigate("/blog", { reload: true });
    first = page.fetch(FIRST_SCREEN[0]);
    page.mountGate();
    assert.equal((await first).status, 200, "重试应拿到数据");
    const seq = tab.log.slice(before).map((r) => `${r.method} ${r.path.split("?")[0]} ${r.status}`);
    assert.deepEqual(
      seq.filter((s) => s.startsWith("GET /api/diaries") || s.startsWith("POST /api/gate/issue")),
      ["GET /api/diaries 403", "POST /api/gate/issue 200", "GET /api/diaries 200"],
      "应为 403 → 重新握手 → 重试 200"
    );
    assert.equal(store.violTotal(ip), 0);
    assert.equal(issued(tab), 2, "首访一次 + 兜底一次");
  });
});
