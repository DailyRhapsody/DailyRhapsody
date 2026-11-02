// node --experimental-test-module-mocks --test tests/notion-refresh-read-failure.test.mjs
//
// 刷新时读旧快照失败，不能当成「没有旧缓存」。
//
// 旧实现用 getCached() 读旧快照，它把 Redis 读失败吞成 null：于是所有正文都进待抓队列，
// 这一轮抓不到正文的文章（限流、超预算）被写成只剩标题，随后 setCache 成功，上一版完整快照
// 被覆盖。夹具：40 篇文章的完整缓存，偶数篇的块接口必失败；刷新中唯一一次 mget 抛错。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test } from "node:test";

const DATABASE = "00000000000000000000000000000031";
const LAST_EDITED = "2026-09-01T00:00:00.000Z";
const N = 40;

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

const pages = Array.from({ length: N }, (_, i) => ({
  object: "page",
  id: `pg${String(i).padStart(4, "0")}`,
  created_time: "2026-08-01T00:00:00.000Z",
  last_edited_time: LAST_EDITED,
  properties: {
    Title: { type: "title", title: [RICH(`第 ${i} 篇`)] },
    Date: { type: "date", date: { start: "2026-09-01" } },
    pin: { type: "checkbox", checkbox: false },
    Public: { type: "checkbox", checkbox: true },
  },
}));

test("刷新时读旧快照失败：放弃本轮，上一版完整正文原样保留", async (t) => {
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
        databases = {
          query: async () => ({ results: structuredClone(pages), has_more: false, next_cursor: null }),
        };
        blocks = {
          children: {
            list: async ({ block_id }) => {
              blockCalls++;
              // 偶数篇模拟这一轮抓不到正文（不可重试的失败）
              if (Number(block_id.slice(2)) % 2 === 0) throw new Error("body fetch failed");
              return {
                results: [
                  {
                    object: "block",
                    id: `x${block_id}`,
                    type: "paragraph",
                    has_children: false,
                    paragraph: { rich_text: [RICH(`新正文 ${block_id}`)], color: "default" },
                  },
                ],
                has_more: false,
                next_cursor: null,
              };
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
  let failNextMget = false;
  t.mock.module("@upstash/redis", {
    namedExports: {
      Redis: class {
        async get(key) {
          return structuredClone(store.get(key) ?? null);
        }
        async mget(...keys) {
          if (failNextMget) {
            failNextMget = false;
            throw new Error("ECONNRESET");
          }
          return keys.map((key) => structuredClone(store.get(key) ?? null));
        }
        async set(key, value, options) {
          if (options?.nx && store.has(key)) return null;
          store.set(key, structuredClone(value));
          return "OK";
        }
        async del(key) {
          return store.delete(key) ? 1 : 0;
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
  // 上一版完整快照：正文都是当前转换器产出、未再编辑，正常刷新应全部复用
  store.set("notion:diaries:v7", {
    data: pages.map((p) => ({
      id: p.id,
      date: "2026-09-01",
      summary: `好正文 ${p.id}`,
      bodyStatus: "complete",
      bodyVersion: BODY_VERSION,
      sourceEditedAt: LAST_EDITED,
      isPublic: true,
      pinned: false,
    })),
    refreshedAt: Date.now() - 10 * 60_000,
    snapshotAt: Date.now() - 10 * 60_000,
  });

  await t.test("对照：读到旧快照时，正文全部复用，不打块接口", async () => {
    const before = blockCalls;
    assert.equal(await warmDiariesCache(), N);
    assert.equal(blockCalls, before, "版本一致且未编辑的正文不应重抓");
    const data = store.get("notion:diaries:v7").data;
    assert.equal(data.filter((d) => d.summary.startsWith("好正文")).length, N);
  });

  await t.test("读旧快照时 Redis 抛错：刷新失败，缓存与别名都不被改写", async () => {
    const v7Before = structuredClone(store.get("notion:diaries:v7"));
    const latestBefore = structuredClone(store.get("notion:diaries:latest") ?? null);
    const before = blockCalls;
    failNextMget = true;

    await assert.rejects(warmDiariesCache(), /读取旧快照失败/);

    assert.equal(failNextMget, false, "夹具的那次 mget 必须真的被刷新路径调用到");
    assert.equal(blockCalls, before, "读旧快照失败后不应再去抓正文");
    assert.deepEqual(store.get("notion:diaries:v7"), v7Before, "主缓存必须原样保留");
    assert.deepEqual(store.get("notion:diaries:latest") ?? null, latestBefore, "别名必须原样保留");
    const titleOnly = store
      .get("notion:diaries:v7")
      .data.filter((d) => /^第 \d+ 篇$/.test(d.summary)).length;
    assert.equal(titleOnly, 0, "不能出现只剩标题的文章");
  });
});
