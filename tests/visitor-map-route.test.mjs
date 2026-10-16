// node --test tests/visitor-map-route.test.mjs
//
// 访客地图公开接口的路由级行为：鉴权（无 gate / 伪造 gate / 管理员 / 合法 gate）与
// 「发布出去的东西里没有隐私字段」。
//
// 与 tests/moments-detail-privacy.test.mjs 同一范式：只替换三个边界（next/headers 的 cookies、
// @/lib/auth 的 isAdmin、@/lib/analytics-store 的数据层），路由自身、限流、响应封装与状态码走真实实现。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// verifyGateValue 要用真实实现，所以给测试进程一个够长的密钥（合法 gate 由 mintGateValue 现签）
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret-at-least-16-chars";
process.env.NEXT_PUBLIC_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tengjun.org";

const PAYLOAD = {
  points: [
    { lat: 40.092, lon: 115.851, count: 38 },
    { lat: 51.303, lon: -0.957, count: 12 },
    { lat: -33.723, lon: 150.894, count: 8 },
  ],
  generatedAt: "2026-10-16T00:00:00.000Z",
  windowDays: 30,
};

/**
 * 只替换三个边界：
 *  - next/headers 的 cookies()：路由里读 dr_gate 用，测试里由 globalThis 提供；
 *  - @/lib/auth 的 isAdmin：管理员分支；
 *  - @/lib/analytics-store 的数据层：避免测试依赖 Redis / Notion。
 */
function registerMocks() {
  return registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "next/server") return next("next/server.js", context);
      if (specifier === "next/headers") {
        return { url: "mock:next-headers", shortCircuit: true, format: "module" };
      }
      if (specifier === "@/lib/auth") {
        return { url: "mock:auth", shortCircuit: true, format: "module" };
      }
      if (specifier === "@/lib/analytics-store") {
        return { url: "mock:store", shortCircuit: true, format: "module" };
      }
      return next(
        specifier.startsWith("@/")
          ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href
          : specifier,
        context,
      );
    },
    load(url, context, next) {
      if (url === "mock:next-headers") {
        return {
          format: "module",
          shortCircuit: true,
          source: `export const cookies = async () => ({
  get: (name) => {
    const jar = globalThis.__DR_TEST_COOKIES__ || {};
    return name in jar ? { value: jar[name] } : undefined;
  },
});`,
        };
      }
      if (url === "mock:auth") {
        return {
          format: "module",
          shortCircuit: true,
          source: `export const isAdmin = async () => globalThis.__DR_TEST_ADMIN__ === true;`,
        };
      }
      if (url === "mock:store") {
        return {
          format: "module",
          shortCircuit: true,
          source: `export const VISITOR_MAP_WINDOW_DAYS = 30;
export const getVisitorMapPayload = async () => (${JSON.stringify(PAYLOAD)});`,
        };
      }
      return next(url, context);
    },
  });
}

registerMocks();

/** 路由模块只导入一次，用例之间共用（模块本身就是单例） */
const routeModule = await import("../app/api/analytics/visitor-map/route.ts");

/** 按真实浏览器站内 fetch 的形状构造请求，避免被测的其实是限流/UA 守卫 */
async function callRoute({ gate, admin } = {}) {
  globalThis.__DR_TEST_ADMIN__ = admin === true;
  globalThis.__DR_TEST_COOKIES__ = gate ? { dr_gate: gate } : {};
  const { GET } = routeModule;
  const res = await GET(
    new Request("https://tengjun.org/api/analytics/visitor-map", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        origin: "https://tengjun.org",
        "sec-fetch-site": "same-origin",
      },
    }),
  );
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（限流等）留 null */
  }
  return { status: res.status, body, text };
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------
test("没有任何凭证：403，且不吐点位", async () => {
  const { status, body, text } = await callRoute();
  assert.equal(status, 403);
  assert.equal(body?.points, undefined);
  assert.ok(!text.includes("count"), "拒绝响应里不该出现点位字段");
});

test("伪造的 dr_gate：403", async () => {
  const { status, body } = await callRoute({ gate: "1792136524139.deadbeef.deadbeef.deadbeef" });
  assert.equal(status, 403);
  assert.equal(body?.points, undefined);
});

test("合法的 dr_gate（现签）：200 并返回点位", async () => {
  const { mintGateValue } = await import("../lib/scrape-gate.ts");
  const { status, body } = await callRoute({ gate: mintGateValue() });
  assert.equal(status, 200);
  assert.equal(body?.points?.length, PAYLOAD.points.length);
});

test("管理员会话：200 并返回点位", async () => {
  const { status, body } = await callRoute({ admin: true });
  assert.equal(status, 200);
  assert.equal(body?.windowDays, 30);
  assert.equal(body?.points?.length, PAYLOAD.points.length);
});

// ---------------------------------------------------------------------------
// 发布内容：只有格子级点位，没有隐私字段
// ---------------------------------------------------------------------------
test("响应里只有 count/lat/lon，没有 IP / 城市 / 国家 / UA / 访问者 ID / referrer", async () => {
  const { body, text } = await callRoute({ admin: true });
  assert.deepEqual(Object.keys(body).sort(), ["generatedAt", "points", "windowDays"]);
  for (const p of body.points) {
    assert.deepEqual(Object.keys(p).sort(), ["count", "lat", "lon"]);
  }
  for (const banned of [
    '"ip"',
    "city",
    "country",
    "userAgent",
    "visitorId",
    "referrer",
    "latitude",
    "longitude",
  ]) {
    assert.ok(!text.includes(banned), `响应里出现了 ${banned}`);
  }
});

test("发布的坐标是 3 位小数以内的格中心", async () => {
  const { body } = await callRoute({ admin: true });
  for (const p of body.points) {
    assert.equal(p.lat, Math.round(p.lat * 1000) / 1000, `${p.lat} 未收敛到 3 位小数`);
    assert.equal(p.lon, Math.round(p.lon * 1000) / 1000, `${p.lon} 未收敛到 3 位小数`);
  }
});
