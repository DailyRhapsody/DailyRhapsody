// node --experimental-test-module-mocks --test tests/moments-detail-privacy.test.mjs
//
// 动态详情的公开性判定。
//
// 这里刻意只替换数据层与鉴权两个边界（getMoments / isAdmin），路由本身、限流、
// 响应封装与状态码都走真实实现：要检出的风险是「私密动态经详情接口泄露给访客」，
// 以及修好之后是否误伤公开动态与管理员。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test } from "node:test";

const MOMENTS = [
  {
    id: "public-1",
    type: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    isPublic: true,
    media: [
      {
        url: "/api/media/b/0000000000000000000000000000000a/0123456789",
        thumbUrl: "/api/media/b/0000000000000000000000000000000a/0123456789",
        mediaType: "image/png",
        width: 0,
        height: 0,
        duration: 0,
        sortOrder: 0,
      },
    ],
  },
  {
    id: "private-1",
    type: 1,
    createdAt: "2026-10-02T00:00:00.000Z",
    isPublic: false,
    media: [
      {
        url: "/api/media/b/0000000000000000000000000000000b/0123456789",
        thumbUrl: "/api/media/b/0000000000000000000000000000000b/0123456789",
        mediaType: "image/png",
        width: 0,
        height: 0,
        duration: 0,
        sortOrder: 0,
      },
    ],
  },
];

/** 同源白名单来自 NEXT_PUBLIC_SITE_URL，测试期间固定站点地址 */
function setSiteUrl() {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://tengjun.org";
  return () => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous;
  };
}

/**
 * 只替换两个边界，其它保持真实实现。
 *
 * 管理员标记放在 globalThis 上由 mock 运行时读取：ESM 模块在同一进程里只求值一次，
 * 若把布尔值内联进 mock 源码，第二个用例会复用第一次导入的模块实例，改不动结果。
 */
function setAdmin(value) {
  globalThis.__DR_TEST_ADMIN__ = value;
}

/** 只替换两个边界，其它保持真实实现 */
function registerRouteMocks() {
  return registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "next/server") return next("next/server.js", context);
      if (specifier === "@/lib/notion-moments") {
        return { url: "mock:notion-moments", shortCircuit: true, format: "module" };
      }
      if (specifier === "@/lib/auth") {
        return { url: "mock:auth", shortCircuit: true, format: "module" };
      }
      return next(
        specifier.startsWith("@/")
          ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href
          : specifier,
        context
      );
    },
    load(url, context, next) {
      if (url === "mock:notion-moments") {
        return {
          format: "module",
          shortCircuit: true,
          source: `export const isMomentsConfigured = () => true;
export const getMoments = async () => ${JSON.stringify(MOMENTS)};`,
        };
      }
      if (url === "mock:auth") {
        return {
          format: "module",
          shortCircuit: true,
          source: `export const isAdmin = async () => globalThis.__DR_TEST_ADMIN__ === true;`,
        };
      }
      return next(url, context);
    },
  });
}

// 路由内的 guardApiRequest 会校验 UA、同源与 Sec-Fetch-Site，这里按真实浏览器
// 站内 fetch 的形状构造请求头，保证测的是隐私分支而不是被前置守卫拦掉
async function requestDetail(id) {
  const { GET } = await import("../app/api/moments/[id]/route.ts");
  const res = await GET(
    new Request(`https://tengjun.org/api/moments/${id}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        origin: "https://tengjun.org",
        "sec-fetch-site": "same-origin",
      },
    }),
    { params: Promise.resolve({ id }) }
  );
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

test("动态详情：公开动态对访客可见", { timeout: 5000 }, async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Real network is forbidden in this test");
  });
  const connectMock = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Real network is forbidden in this test");
  });

  const restore = setSiteUrl();
  setAdmin(false);
  const hooks = registerRouteMocks();
  t.after(() => {
    hooks.deregister();
    restore();
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
  });

  const res = await requestDetail("public-1");
  assert.equal(res.status, 200);
  assert.equal(res.body?.id, "public-1");
});

test("动态详情：私密动态对访客返回 404，且不回显内容", { timeout: 5000 }, async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Real network is forbidden in this test");
  });
  const connectMock = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Real network is forbidden in this test");
  });

  const restore = setSiteUrl();
  setAdmin(false);
  const hooks = registerRouteMocks();
  t.after(() => {
    hooks.deregister();
    restore();
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
  });

  const res = await requestDetail("private-1");
  assert.equal(res.status, 404);
  assert.equal(res.body?.error, "Not found");
  // 关键：响应里不能出现这条私密动态的任何内容
  assert.equal(JSON.stringify(res.body).includes("private-1"), false);
  assert.equal(JSON.stringify(res.body).includes("0000000000000000000000000000000b"), false);
});

test("动态详情：私密动态对管理员可见", { timeout: 5000 }, async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Real network is forbidden in this test");
  });
  const connectMock = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Real network is forbidden in this test");
  });

  const restore = setSiteUrl();
  setAdmin(true);
  const hooks = registerRouteMocks();
  t.after(() => {
    hooks.deregister();
    restore();
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
  });

  const res = await requestDetail("private-1");
  assert.equal(res.status, 200);
  assert.equal(res.body?.id, "private-1");
  assert.equal(res.body?.isPublic, false);
});

test("动态详情：不存在的 id 仍是 404", { timeout: 5000 }, async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Real network is forbidden in this test");
  });
  const connectMock = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Real network is forbidden in this test");
  });

  const restore = setSiteUrl();
  setAdmin(false);
  const hooks = registerRouteMocks();
  t.after(() => {
    hooks.deregister();
    restore();
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
  });

  const res = await requestDetail("missing-id");
  assert.equal(res.status, 404);
});
