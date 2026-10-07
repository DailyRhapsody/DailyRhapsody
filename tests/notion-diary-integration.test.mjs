// Node 26: node --experimental-test-module-mocks --test tests/notion-diary-integration.test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test } from "node:test";

const CURRENT = "notion:diaries:v5";
const LEGACY = "notion:diaries:v4";
const DATABASE = "00000000000000000000000000000001";
const richText = (text) => ({
  type: "text", text: { content: text, link: null }, plain_text: text, href: null,
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
});
const page = (id, createdTime, pinned = false) => ({
  object: "page", id,
  created_time: createdTime,
  properties: {
    Title: { type: "title", title: [richText(id)] },
    Date: { type: "created_time", created_time: createdTime },
    pin: { type: "checkbox", checkbox: pinned },
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
      if (specifier === "next/server") return next("next/server.js", context);
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
  let registered = Promise.withResolvers();
  let background;
  const query = t.mock.fn(async ({ database_id, start_cursor, page_size }) => {
    assert.equal(database_id, DATABASE);
    if (queryGate) await queryGate.promise;
    const start = Number(start_cursor ?? 0);
    const end = start + page_size;
    return {
      results: structuredClone(pages.slice(start, end)),
      has_more: end < pages.length,
      next_cursor: end < pages.length ? String(end) : null,
    };
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
  const { getDiaries, warmDiariesCache, getCachedDiaries, getDiaryById, markDiariesCacheStale } = await import("../lib/notion.ts");

  await t.test("maps Date.created_time, sorts by milliseconds with pinned first, and warms v5", async () => {
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
    assert.equal(store.has(LEGACY), false, "refresh writes only v5");
  });

  await t.test("v5 wins when an older deployment writes or overwrites v4", async () => {
    const current = await getCachedDiaries();
    for (const summary of ["old", "overwritten by v4"]) {
      store.set(LEGACY, { data: [{ id: "warmed", date: "2026-10-01", summary }], refreshedAt: Date.now() });
      assert.deepEqual(await getDiaries(), current);
      assert.deepEqual(await getCachedDiaries(), current);
    }
    assert.equal(query.mock.callCount(), 2, "fresh v5 causes no SDK query");
  });

  await t.test("v4 remains a read-only media seed when v5 is missing, then refreshes", async () => {
    store.delete(CURRENT);
    const legacy = [{ id: "seed", date: "2026-09-30", isPublic: true,
      summary: "![](/api/media/b/test/abc)", images: ["/api/media/p/test/abc"] }];
    const oldEntry = { data: legacy, refreshedAt: Date.now() };
    store.set(LEGACY, oldEntry);
    const priorWrites = writes.length;
    assert.deepEqual(await getCachedDiaries(), legacy);
    assert.equal(query.mock.callCount(), 2);
    assert.equal(writes.length, priorWrites, "media cache read must not start a refresh");
    pages = [page("seed", "2026-09-30T16:30:00.123Z")];
    queryGate = Promise.withResolvers();
    try {
      assert.deepEqual(await getDiaries(), legacy, "returns seed before the blocked refresh finishes");
      await registered.promise;
      assert.equal(store.has(CURRENT), false);
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
    assert.deepEqual(store.get(LEGACY), oldEntry);
    assert.deepEqual(writes.slice(priorWrites), ["notion:diaries:v2:refreshLock", CURRENT]);
  });

  await t.test("pin takes precedence over Pinned; missing fields remain unpinned", async () => {
    const legacy = page("legacy", "2026-10-01T00:00:00.000Z");
    delete legacy.properties.pin;
    legacy.properties.Pinned = { type: "checkbox", checkbox: true };
    const unpinned = page("unpinned", "2026-10-02T00:00:00.000Z", false);
    unpinned.properties.Pinned = { type: "checkbox", checkbox: true };
    const missing = page("missing", "2026-10-03T00:00:00.000Z");
    delete missing.properties.pin;
    pages = [unpinned, missing, legacy, page("pinned", "2026-10-04T00:00:00.000Z", true)];
    await warmDiariesCache();
    assert.deepEqual((await getDiaries()).map(({ id, pinned }) => [id, pinned]), [
      ["pinned", true], ["legacy", true], ["missing", false], ["unpinned", false],
    ]);
  });

  await t.test("pinned articles use creation time even when manual Date order differs", async () => {
    const older = page("older-created", "2026-07-01T00:00:00.000Z", true);
    older.properties.Date = { type: "date", date: { start: "2026-10-07T00:00:00.000Z" } };
    const newer = page("newer-created", "2026-08-01T00:00:00.000Z", true);
    newer.properties.Date = { type: "date", date: { start: "2026-09-01T00:00:00.000Z" } };
    const ordinaryLaterDate = page("ordinary-later-date", "2026-05-01T00:00:00.000Z");
    ordinaryLaterDate.properties.Date = { type: "date", date: { start: "2026-10-08T00:00:00.000Z" } };
    const ordinaryEarlierDate = page("ordinary-earlier-date", "2026-06-01T00:00:00.000Z");
    ordinaryEarlierDate.properties.Date = { type: "date", date: { start: "2026-08-01T00:00:00.000Z" } };
    pages = [older, ordinaryEarlierDate, newer, ordinaryLaterDate];
    await warmDiariesCache();
    assert.deepEqual((await getDiaries()).map((d) => d.id), ["newer-created", "older-created", "ordinary-later-date", "ordinary-earlier-date"]);
    assert.equal((await getDiaryById("newer-created")).publishedAt, "2026-09-01T00:00:00.000Z", "display date remains unchanged");
    older.properties.pin.checkbox = false;
    await warmDiariesCache();
    assert.deepEqual((await getDiaries()).map((d) => d.id), ["newer-created", "ordinary-later-date", "older-created", "ordinary-earlier-date"], "unpinning returns the article to display-date order");
  });

  await t.test("real list route preserves global pin order across source and visitor pages", async () => {
    let admin = false;
    // Only the request identity/guard are stubbed; data mapping, sorting, filtering,
    // pagination, outline construction and NextResponse serialization are real.
    t.mock.module("../lib/auth.ts", { exports: { isAdmin: async () => admin } });
    t.mock.module("../lib/request-guard.ts", { exports: {
      guardApiRequest: async () => null,
      withAntiScrapeHeaders: (response) => response,
    } });
    const { GET } = await import("../app/api/diaries/route.ts");
    const request = async (params = "limit=30&offset=0&outline=1") => {
      const response = await GET(new Request(`http://blog.test.invalid/api/diaries?${params}`));
      assert.equal(response.status, 200);
      return response.json();
    };
    const normal = Array.from({ length: 70 }, (_, i) =>
      page(`normal-${i + 1}`, new Date(Date.UTC(2026, 9, 7) + i).toISOString()));
    const pinned = Array.from({ length: 35 }, (_, i) => {
      const entry = page(`pin-${i + 1}`, new Date(Date.UTC(2026, 9, 1) + i).toISOString(), true);
      entry.properties.Tags = { type: "multi_select", multi_select: [{ name: "chosen" }] };
      return entry;
    });
    const privatePin = page("private-pin", "2026-10-08T00:00:00.000Z", true);
    privatePin.properties.Public.checkbox = false;
    privatePin.properties.Tags = { type: "multi_select", multi_select: [{ name: "private-only" }] };
    // Deliberately put some pinned pages beyond the SDK's 100-page boundary.
    pages = [...normal, ...pinned, privatePin];
    const callsBefore = query.mock.callCount();
    await warmDiariesCache();
    assert.equal(query.mock.callCount() - callsBefore, 2);
    assert.equal(query.mock.calls.at(-1).arguments[0].start_cursor, "100");
    const expected = [...pinned].reverse().concat([...normal].reverse()).map((entry) => entry.id);
    const first = await request();
    const second = await request("limit=30&offset=30");
    const third = await request("limit=30&offset=60");
    const last = await request("limit=30&offset=90");
    assert.equal(first.total, 105);
    assert.deepEqual(first.items.map((d) => d.id), expected.slice(0, 30));
    assert.deepEqual(second.items.map((d) => d.id), expected.slice(30, 60));
    assert.deepEqual([first, second, third, last].flatMap((body) => body.items.map((d) => d.id)), expected);
    assert.deepEqual([first, second, third, last].map((body) => body.hasMore), [true, true, true, false]);
    assert.equal(second.items.filter((d) => d.pinned).length, 5);
    assert.deepEqual(first.outline.map((d) => d.id), expected);
    assert.equal(first.outline.filter((d) => d.pinned).length, 35);
    assert.equal(JSON.stringify(first).includes("private-only"), false);
    assert.equal(JSON.stringify(first).includes("private-pin"), false);
    for (const filter of ["tag=private-only", "q=private-pin"]) {
      const hidden = await request(`limit=30&outline=1&${filter}`);
      assert.equal(hidden.total, 0);
      assert.deepEqual(hidden.items, []);
      assert.deepEqual(hidden.outline, []);
      assert.equal(hidden.hasMore, false);
      assert.equal(hidden.tagCounts.some((tag) => tag.name === "private-only"), false);
      assert.equal(hidden.dates.includes("2026-10-08"), false);
    }
    const chosen = await request("limit=30&tag=chosen&q=pin-3&outline=1");
    assert.deepEqual(chosen.items.map((d) => d.id), ["pin-35", "pin-34", "pin-33", "pin-32", "pin-31", "pin-30", "pin-3"]);
    assert.deepEqual(chosen.outline.map((d) => d.id), chosen.items.map((d) => d.id));
    admin = true;
    const owner = await request();
    assert.equal(owner.total, 106);
    assert.equal(owner.items[0].id, "private-pin");
    admin = false;

    // The shared invalidation entry point must refresh the same page after unpinning.
    pinned.at(-1).properties.pin.checkbox = false;
    registered = Promise.withResolvers();
    await markDiariesCacheStale();
    assert.ok(Number(store.get("notion:diaries:v2:invalidatedAt")) > 0);
    await registered.promise;
    await background;
    const after = await request();
    assert.equal(after.items[0].id, "pin-34");
    assert.equal(after.outline.filter((d) => d.pinned).length, 34);
    assert.equal(after.outline.at(-1).id, "pin-35", "unpinned old page returns to chronological position");
    assert.equal((await getDiaryById("pin-35")).pinned, false);
  });

  await t.test("an older deployment's shared refresh lock preserves the legacy seed", async () => {
    store.delete(CURRENT);
    const legacy = { data: [{ id: "locked-seed", date: "2026-10-01", summary: "cached body" }], refreshedAt: Date.now() };
    store.set(LEGACY, legacy);
    const lockKey = "notion:diaries:v2:refreshLock";
    store.set(lockKey, "older-deployment");
    const callsBefore = query.mock.callCount();
    registered = Promise.withResolvers();
    assert.deepEqual(await getDiaries(), legacy.data);
    await registered.promise;
    await background;
    assert.equal(query.mock.callCount(), callsBefore);
    assert.equal(store.get(lockKey), "older-deployment");
    assert.equal(store.has(CURRENT), false);
    store.delete(lockKey); // Simulate the older deployment releasing its own lock.
    registered = Promise.withResolvers();
    await getDiaries();
    await registered.promise;
    await background;
    assert.equal(store.has(CURRENT), true);
    assert.equal(query.mock.callCount() - callsBefore, 2);
    assert.deepEqual(store.get(LEGACY), legacy);
  });

  await t.test("shared invalidation refreshes a fresh v5 snapshot after a busy lock is released", async () => {
    const signalKey = "notion:diaries:v2:invalidatedAt";
    const lockKey = "notion:diaries:v2:refreshLock";
    const freshSeed = [{ id: "fresh-seed", date: "2026-10-01", summary: "cached body", pinned: true }];
    store.set(CURRENT, { data: freshSeed, refreshedAt: Date.now(), snapshotAt: Date.now() - 1000 });
    store.delete(signalKey);
    store.set(lockKey, "older-deployment");
    const callsBefore = query.mock.callCount();
    registered = Promise.withResolvers();
    await markDiariesCacheStale();
    assert.ok(Number(store.get(signalKey)) > store.get(CURRENT).snapshotAt);
    await registered.promise;
    await background;
    assert.equal(query.mock.callCount(), callsBefore);
    assert.deepEqual(await getCachedDiaries(), freshSeed);
    store.delete(lockKey);
    registered = Promise.withResolvers();
    assert.deepEqual(await getDiaries(), freshSeed, "fresh snapshot remains available during refresh");
    await registered.promise;
    await background;
    assert.equal(query.mock.callCount() - callsBefore, 2);
    assert.equal((await getCachedDiaries()).some((d) => d.id === "fresh-seed"), false);
  });
});
