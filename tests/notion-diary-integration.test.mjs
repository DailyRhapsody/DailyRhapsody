// Node 26: node --experimental-test-module-mocks --test tests/notion-diary-integration.test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test } from "node:test";

const V3 = "notion:diaries:v3";
const V2 = "notion:diaries:v2";
const DATABASE = "00000000000000000000000000000001";
const richText = (text) => ({
  type: "text", text: { content: text, link: null }, plain_text: text, href: null,
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
});
const page = (id, createdTime, pinned = false) => ({
  object: "page", id,
  // The Date property must win over the page's own creation timestamp.
  created_time: "2000-01-01T00:00:00.000Z",
  properties: {
    Title: { type: "title", title: [richText(id)] },
    Date: { type: "created_time", created_time: createdTime },
    Pinned: { type: "checkbox", checkbox: pinned },
    Public: { type: "checkbox", checkbox: true },
  },
});

test("offline integration of the real Notion diary exports", { timeout: 5000 }, async (t) => {
  const env = {
    NODE_ENV: "test", NOTION_TOKEN: "test-notion-token", NOTION_DATABASE_ID: DATABASE,
    NOTION_CACHE_STALE_S: "300", NOTION_CACHE_TTL: "172800",
    UPSTASH_REDIS_REST_URL: "https://redis.test.invalid", UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
  };
  const originalEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return next(specifier.startsWith("@/")
        ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier, context);
    },
  });
  const blocked = () => { throw new Error("Real network is forbidden in this test"); };
  const fetch = t.mock.method(globalThis, "fetch", blocked);
  const connect = t.mock.method(Socket.prototype, "connect", blocked);
  t.after(() => {
    hooks.deregister();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Production catches some errors: swallowed network attempts must also fail.
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(connect.mock.callCount(), 0);
  });

  const store = new Map();
  const writes = [];
  let pages = [];
  let queryGate;
  const registered = Promise.withResolvers();
  let background;
  const query = t.mock.fn(async ({ database_id }) => {
    assert.equal(database_id, DATABASE);
    if (queryGate) await queryGate.promise;
    return { results: structuredClone(pages), has_more: false, next_cursor: null };
  });
  const retrieve = t.mock.fn(() => { throw new Error("Unexpected detail cache miss"); });
  t.mock.module("@notionhq/client", { exports: {
    Client: class {
      constructor({ auth }) { assert.equal(auth, "test-notion-token"); }
      databases = { query };
      pages = { retrieve };
      blocks = { children: { list: async ({ block_id }) => ({
        results: [{ object: "block", id: `${block_id}-body`, type: "paragraph", has_children: false,
          paragraph: { rich_text: [richText(`body:${block_id}`)], color: "default" } }],
        has_more: false, next_cursor: null,
      }) } };
    },
    APIResponseError: { isAPIResponseError: () => false }, APIErrorCode: {},
    RequestTimeoutError: { isRequestTimeoutError: () => false },
  } });
  const read = (key) => structuredClone(store.get(key) ?? null);
  t.mock.module("@upstash/redis", { exports: { Redis: class {
    constructor({ url, token }) {
      assert.equal(url, env.UPSTASH_REDIS_REST_URL);
      assert.equal(token, "test-redis-token");
    }
    async get(key) { return read(key); }
    async mget(...keys) { return keys.map(read); }
    async set(key, value, options) {
      writes.push(key);
      if (options?.nx && store.has(key)) return null;
      store.set(key, structuredClone(value));
      return "OK";
    }
    async eval(script, [key], [token]) {
      assert.ok(script.includes('redis.call("del"'), "only successful lock release is expected");
      return store.get(key) === token ? Number(store.delete(key)) : 0;
    }
  } } });
  t.mock.module("@vercel/functions", { exports: { waitUntil(task) {
    background = task;
    registered.resolve();
  } } });
  const { getDiaries, warmDiariesCache, getCachedDiaries, getDiaryById } = await import("../lib/notion.ts");

  await t.test("maps Date.created_time, sorts by milliseconds with pinned first, and warms v3", async () => {
    pages = [
      page("early", "2026-09-30T16:30:00.001Z"),
      page("pin-early", "2026-09-30T16:00:00.001Z", true),
      page("late", "2026-09-30T16:30:00.002Z"),
      page("pin-late", "2026-09-30T16:00:00.002Z", true),
    ];
    const diaries = await getDiaries();
    assert.deepEqual(diaries.map((d) => [d.id, d.date, d.publishedAt, d.pinned]), [
      ["pin-late", "2026-10-01", "2026-09-30T16:00:00.002Z", true],
      ["pin-early", "2026-10-01", "2026-09-30T16:00:00.001Z", true],
      ["late", "2026-10-01", "2026-09-30T16:30:00.002Z", false],
      ["early", "2026-10-01", "2026-09-30T16:30:00.001Z", false],
    ]);
    assert.equal(diaries[0].summary, "body:pin-late", "body conversion must not fall back to the title");
    assert.deepEqual(await getCachedDiaries(), diaries);
    assert.deepEqual(await getDiaryById("late"), diaries[2]);
    assert.equal(retrieve.mock.callCount(), 0);
    pages = [page("warmed", "2026-10-01T16:00:00.456Z")];
    assert.equal(await warmDiariesCache(), 1, "warm refreshes even a fresh cache");
    const [warmed] = await getCachedDiaries();
    assert.deepEqual([warmed.id, warmed.date, warmed.publishedAt],
      ["warmed", "2026-10-02", "2026-10-01T16:00:00.456Z"]);
    assert.equal(warmed.summary, "body:warmed");
    assert.equal(query.mock.callCount(), 2);
    assert.equal(store.has(V2), false, "refresh writes only v3");
  });

  await t.test("v3 wins when an older deployment writes or overwrites v2", async () => {
    const current = await getCachedDiaries();
    for (const summary of ["old", "overwritten by v2"]) {
      store.set(V2, { data: [{ id: "warmed", date: "2026-10-01", summary }], refreshedAt: Date.now() });
      assert.deepEqual(await getDiaries(), current);
      assert.deepEqual(await getCachedDiaries(), current);
    }
    assert.equal(query.mock.callCount(), 2, "fresh v3 causes no SDK query");
  });

  await t.test("v2 remains a read-only media seed when v3 is missing, then refreshes", async () => {
    store.delete(V3);
    const legacy = [{ id: "seed", date: "2026-09-30", isPublic: true,
      summary: "![](/api/media/b/test/abc)", images: ["/api/media/p/test/abc"] }];
    const oldEntry = { data: legacy, refreshedAt: Date.now() };
    store.set(V2, oldEntry);
    const priorWrites = writes.length;
    assert.deepEqual(await getCachedDiaries(), legacy);
    assert.equal(query.mock.callCount(), 2);
    assert.equal(writes.length, priorWrites, "media cache read must not start a refresh");
    pages = [page("seed", "2026-09-30T16:30:00.123Z")];
    queryGate = Promise.withResolvers();
    try {
      assert.deepEqual(await getDiaries(), legacy, "returns seed before the blocked refresh finishes");
      await registered.promise;
      assert.equal(store.has(V3), false);
    } finally {
      queryGate.resolve();
      await background;
    }
    const [fresh] = await getCachedDiaries();
    assert.deepEqual([fresh.id, fresh.date, fresh.publishedAt],
      ["seed", "2026-10-01", "2026-09-30T16:30:00.123Z"]);
    assert.equal(fresh.summary, "body:seed", "refresh replaces the legacy body");
    assert.deepEqual(await getDiaries(), [fresh]);
    assert.equal(query.mock.callCount(), 3);
    assert.deepEqual(store.get(V2), oldEntry);
    assert.deepEqual(writes.slice(priorWrites), [`${V2}:refreshLock`, V3]);
  });
});
