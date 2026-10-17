// node --experimental-test-module-mocks --test tests/notion-body-migration.test.mjs
//
// 换正文转换器后，旧缓存里的正文必须重抓——只换缓存键不会让存量文章重转换。
// 这个夹具模拟「v6 里有一条 complete 的旧正文」：刷新后 v7 必须是新转换器的
// 输出（带嵌套缩进）且 bodyVersion 更新；再刷新一次则应复用、不再打 Notion。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test } from "node:test";

const PAGE_ID = "page-migrate";
const DATABASE = "00000000000000000000000000000002";
const LAST_EDITED = "2026-10-01T00:00:00.000Z";

const RICH = (text) => ({
  type: "text",
  text: { content: text, link: null },
  plain_text: text,
  href: null,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
});

const page = {
  object: "page",
  id: PAGE_ID,
  created_time: LAST_EDITED,
  last_edited_time: LAST_EDITED,
  properties: {
    Title: { type: "title", title: [RICH("迁移测试")] },
    Date: { type: "created_time", created_time: LAST_EDITED },
    pin: { type: "checkbox", checkbox: false },
    Public: { type: "checkbox", checkbox: true },
  },
};

const blocks = new Map([
  [
    PAGE_ID,
    [
      { object: "block", id: "b1", type: "bulleted_list_item", has_children: true, bulleted_list_item: { rich_text: [RICH("一级")], color: "default" } },
      { object: "block", id: "b2", type: "bulleted_list_item", has_children: false, bulleted_list_item: { rich_text: [RICH("兄弟")], color: "default" } },
    ],
  ],
  [
    "b1",
    [
      { object: "block", id: "b1a", type: "bulleted_list_item", has_children: false, bulleted_list_item: { rich_text: [RICH("二级")], color: "default" } },
    ],
  ],
]);

test("旧转换器产出的正文在换版后会被重抓，之后才复用", async (t) => {
  process.env.NODE_ENV = "test";
  process.env.NOTION_TOKEN = "test-notion-token";
  process.env.NOTION_DATABASE_ID = DATABASE;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";

  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "next/server") return next("next/server.js", context);
      return next(
        specifier.startsWith("@/")
          ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href
          : specifier,
        context
      );
    },
  });

  let blockCalls = 0;
  t.mock.module("@notionhq/client", {
    namedExports: {
      Client: class {
        constructor({ auth }) {
          assert.equal(auth, "test-notion-token");
        }
        databases = {
          query: async () => ({ results: [structuredClone(page)], has_more: false, next_cursor: null }),
        };
        blocks = {
          children: {
            list: async ({ block_id }) => {
              blockCalls++;
              return { results: structuredClone(blocks.get(block_id) ?? []), has_more: false, next_cursor: null };
            },
          },
        };
      },
      APIResponseError: { isAPIResponseError: () => false },
      APIErrorCode: {},
      RequestTimeoutError: { isRequestTimeoutError: () => false },
    },
  });

  const store = new Map();
  // v6：上一版转换器的正文，列表被拍平，没有 bodyVersion 字段
  store.set("notion:diaries:v6", {
    data: [
      {
        id: PAGE_ID,
        date: "2026-10-01",
        summary: "旧正文：- 一级\n\n- 二级",
        bodyStatus: "complete",
        sourceEditedAt: LAST_EDITED,
      },
    ],
    refreshedAt: Date.now() - 60_000,
  });

  t.mock.module("@upstash/redis", {
    namedExports: {
      Redis: class {
        constructor() {}
        async get(key) {
          return structuredClone(store.get(key) ?? null);
        }
        async mget(...keys) {
          return keys.map((key) => structuredClone(store.get(key) ?? null));
        }
        async set(key, value, options) {
          if (options?.nx && store.has(key)) return null;
          store.set(key, structuredClone(value));
          return "OK";
        }
        async eval() {
          return 1;
        }
      },
    },
  });
  t.mock.module("@vercel/functions", {
    namedExports: { waitUntil(task) { void task; } },
  });

  const blocked = () => {
    throw new Error("Real network is forbidden in this test");
  };
  const fetchMock = t.mock.method(globalThis, "fetch", blocked);
  const connectMock = t.mock.method(Socket.prototype, "connect", blocked);

  t.after(() => {
    hooks.deregister();
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
  });

  const { warmDiariesCache, BODY_VERSION } = await import("../lib/notion.ts");

  await t.test("首次刷新：v6 的旧正文会被重抓成 v7 的新形状", async () => {
    const count = await warmDiariesCache();
    assert.equal(count, 1);
    const v7 = store.get("notion:diaries:v7");
    assert.ok(v7, "v7 必须写入");
    const diary = v7.data[0];
    assert.equal(diary.bodyVersion, BODY_VERSION);
    assert.equal(diary.bodyStatus, "complete");
    assert.ok(diary.summary.includes("- 一级\n  - 二级"), JSON.stringify(diary.summary));
    assert.ok(!diary.summary.includes("旧正文"), diary.summary);
    assert.ok(blockCalls > 0, "必须真的请求过 Notion 的块树");
  });

  await t.test("第二次刷新：版本一致且未编辑，复用正文不再打 Notion", async () => {
    const before = blockCalls;
    await warmDiariesCache();
    assert.equal(blockCalls, before, "不应重复请求块树");
  });
});
