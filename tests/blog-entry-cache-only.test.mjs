// node --experimental-test-module-mocks --test tests/blog-entry-cache-only.test.mjs
//
// 单篇文章页 /blog/[id] 是公开页面，读文章只认缓存：缓存里没有的 id 直接当不存在。
// 旧实现用 getDiaryById，缓存未命中就回源 Notion（pages.retrieve 加整篇块树），
// 任意编一个 id 就能换来一串 Notion 调用，脚本循环请求即可耗尽 3 req/s 的配额。
// 缓存整体缺失（冷启动、Redis 读不到）时仍回源，保证新部署不出现整站 404。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test } from "node:test";

const DATABASE = "00000000000000000000000000000003";
const CACHED_ID = "34e9f71b-9bc2-8158-9425-ea65b783acd3";
const UNKNOWN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FRESH_ID = "3f89f71b-9bc2-80b0-8552-f0e4ac677a16";
const EDITED = "2026-10-01T00:00:00.000Z";

const RICH = (text) => ({
  type: "text",
  text: { content: text, link: null },
  plain_text: text,
  href: null,
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
});

/** Notion 里的页：FRESH_ID 属于日记库；其余 id 属于别的库（getDiaryById 会当不存在） */
const notionPage = (id) => ({
  object: "page",
  id,
  created_time: EDITED,
  last_edited_time: EDITED,
  archived: false,
  in_trash: false,
  parent: { type: "database_id", database_id: id === FRESH_ID ? DATABASE : "0".repeat(32) },
  properties: {
    Title: { type: "title", title: [RICH("冷启动回源")] },
    Date: { type: "created_time", created_time: EDITED },
    pin: { type: "checkbox", checkbox: false },
    Public: { type: "checkbox", checkbox: true },
  },
});

test("/blog/[id] 只读缓存，缓存未命中不回源 Notion", async (t) => {
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

  const notionCalls = { retrieve: [], blocks: 0, query: 0 };
  t.mock.module("@notionhq/client", {
    namedExports: {
      Client: class {
        pages = {
          retrieve: async ({ page_id }) => {
            notionCalls.retrieve.push(page_id);
            return structuredClone(notionPage(page_id));
          },
        };
        blocks = {
          children: {
            list: async () => {
              notionCalls.blocks++;
              return {
                results: [
                  { object: "block", id: "p1", type: "paragraph", has_children: false, paragraph: { rich_text: [RICH("现抓的正文")], color: "default" } },
                ],
                has_more: false,
                next_cursor: null,
              };
            },
          },
        };
        databases = {
          query: async () => {
            notionCalls.query++;
            return { results: [], has_more: false, next_cursor: null };
          },
        };
      },
      APIResponseError: { isAPIResponseError: () => false },
      APIErrorCode: {},
      RequestTimeoutError: { isRequestTimeoutError: () => false },
    },
  });

  const store = new Map();
  const seedFreshCache = () => {
    store.clear();
    const now = Date.now();
    store.set("notion:diaries:v7", {
      data: [{ id: CACHED_ID, date: "2021-04-11", summary: "缓存里的正文", isPublic: true, bodyStatus: "complete" }],
      refreshedAt: now,
      snapshotAt: now,
    });
  };
  t.mock.module("@upstash/redis", {
    namedExports: {
      Redis: class {
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

  const { getCachedDiaryById, getDiaryById } = await import("../lib/notion.ts");
  const resetCalls = () => {
    notionCalls.retrieve.length = 0;
    notionCalls.blocks = 0;
    notionCalls.query = 0;
  };

  await t.test("缓存里有的文章：直接返回，不打 Notion", async () => {
    seedFreshCache();
    resetCalls();
    const diary = await getCachedDiaryById(CACHED_ID);
    assert.equal(diary?.id, CACHED_ID);
    assert.equal(diary?.summary, "缓存里的正文");
    assert.deepEqual(notionCalls, { retrieve: [], blocks: 0, query: 0 });
  });

  await t.test("缓存里没有的 id：当不存在，不打 Notion", async () => {
    seedFreshCache();
    resetCalls();
    for (let i = 0; i < 5; i++) assert.equal(await getCachedDiaryById(UNKNOWN_ID), null);
    assert.deepEqual(notionCalls, { retrieve: [], blocks: 0, query: 0 });
  });

  await t.test("对照：getDiaryById 对同一个 id 会回源 Notion（列表与后台仍走它）", async () => {
    seedFreshCache();
    resetCalls();
    assert.equal(await getDiaryById(UNKNOWN_ID), null);
    assert.deepEqual(notionCalls.retrieve, [UNKNOWN_ID]);
  });

  await t.test("缓存整体缺失（冷启动）：回源 Notion，读到正文", async () => {
    store.clear();
    resetCalls();
    const diary = await getCachedDiaryById(FRESH_ID);
    assert.equal(diary?.id, FRESH_ID);
    assert.ok(diary?.summary.includes("现抓的正文"), diary?.summary);
    assert.deepEqual(notionCalls.retrieve, [FRESH_ID]);
    assert.ok(notionCalls.blocks > 0);
  });
});
