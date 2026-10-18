// node --experimental-test-module-mocks --test tests/reference-interactions.test.mjs
//
// 点赞与评论的存储层单测：假 Redis 覆盖 Set / Hash / String 三类命令。
// 守卫：
//  - 点赞 cookie 只能被本站签名识别，篡改后必须当没有
//  - 点赞是 Set 去重，SADD/ SREM 幂等
//  - 评论只写 dr:ref:comments:*，绝不碰日记键 dr:comments:*
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const PAGE_ID = "11111111111111111111111111111111";

test("reference likes and comments stay isolated from diary keys", { timeout: 8000 }, async (t) => {
  process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";
  delete process.env.NODE_ENV;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return next(
        specifier.startsWith("@/")
          ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href
          : specifier,
        context
      );
    },
  });

  const sets = new Map();
  const hashes = new Map();
  const strings = new Map();

  const setOf = (key) => {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key);
  };
  const hashOf = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };

  const redis = {
    async sadd(key, member) {
      const size = setOf(key).size;
      setOf(key).add(String(member));
      return setOf(key).size > size ? 1 : 0;
    },
    async srem(key, member) {
      return setOf(key).delete(String(member)) ? 1 : 0;
    },
    async scard(key) {
      return setOf(key).size;
    },
    async sismember(key, member) {
      return setOf(key).has(String(member)) ? 1 : 0;
    },
    async smembers(key) {
      return [...setOf(key)];
    },
    async hset(key, obj) {
      for (const [field, value] of Object.entries(obj)) hashOf(key).set(field, String(value));
      return Object.keys(obj).length;
    },
    async hlen(key) {
      return hashOf(key).size;
    },
    async hgetall(key) {
      const out = [];
      for (const [field, value] of hashOf(key)) out.push(field, value);
      return out;
    },
    async hdel(key, field) {
      return hashOf(key).delete(field) ? 1 : 0;
    },
    async incr(key) {
      const next = Number(strings.get(key) ?? 0) + 1;
      strings.set(key, String(next));
      return next;
    },
    async get(key) {
      return strings.get(key) ?? null;
    },
    async mget(...keys) {
      const flat = keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys;
      return flat.map((key) => strings.get(key) ?? null);
    },
    async set(key, value) {
      strings.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return "OK";
    },
    async del(...keys) {
      for (const key of keys) {
        sets.delete(key);
        hashes.delete(key);
        strings.delete(key);
      }
      return keys.length;
    },
    pipeline() {
      const ops = [];
      return {
        scard(key) {
          ops.push(async () => setOf(key).size);
          return this;
        },
        sismember(key, member) {
          ops.push(async () => (setOf(key).has(String(member)) ? 1 : 0));
          return this;
        },
        hgetall(key) {
          ops.push(async () => {
            const out = [];
            for (const [field, value] of hashOf(key)) out.push(field, value);
            return out;
          });
          return this;
        },
        hlen(key) {
          ops.push(async () => hashOf(key).size);
          return this;
        },
        async exec() {
          return Promise.all(ops.map((fn) => fn()));
        },
      };
    },
    multi() {
      const ops = [];
      return {
        hset(key, obj) {
          ops.push(async () => {
            for (const [field, value] of Object.entries(obj)) hashOf(key).set(field, String(value));
            return Object.keys(obj).length;
          });
          return this;
        },
        sadd(key, member) {
          ops.push(async () => {
            setOf(key).add(String(member));
            return 1;
          });
          return this;
        },
        incr(key) {
          ops.push(async () => {
            const next = Number(strings.get(key) ?? 0) + 1;
            strings.set(key, String(next));
            return next;
          });
          return this;
        },
        async exec() {
          return Promise.all(ops.map((fn) => fn()));
        },
      };
    },
  };

  t.mock.module("@upstash/redis", {
    namedExports: {
      Redis: class {
        constructor() {
          return redis;
        }
      },
    },
  });

  const likes = await import("../lib/reference-likes.ts");
  const comments = await import("../lib/reference-comments.ts");

  t.after(() => hooks.deregister());

  await t.test("like cookie is signed and tamper-evident", () => {
    const did = likes.newLikeDeviceId();
    assert.match(did, /^[0-9a-f]{32}$/);
    const cookie = likes.mintLikeCookie(did);
    const header = cookie.split(";")[0];
    assert.equal(likes.readLikeDeviceId(header), did);

    const value = header.slice(header.indexOf("=") + 1);
    const tampered = value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
    assert.equal(likes.readLikeDeviceId(`dr_like=${tampered}`), null);
    assert.equal(likes.readLikeDeviceId("dr_like=not-a-cookie"), null);
    assert.equal(likes.readLikeDeviceId(null), null);
  });

  await t.test("like is a set: idempotent add/remove and batch state", async () => {
    const a = "a".repeat(32);
    const b = "b".repeat(32);

    assert.deepEqual(await likes.setReferenceLike(PAGE_ID, a, "like"), { count: 1, liked: true });
    assert.deepEqual(await likes.setReferenceLike(PAGE_ID, a, "like"), { count: 1, liked: true });
    assert.deepEqual(await likes.setReferenceLike(PAGE_ID, b, "like"), { count: 2, liked: true });
    assert.deepEqual(await likes.setReferenceLike(PAGE_ID, a, "unlike"), { count: 1, liked: false });

    const batch = await likes.getReferenceLikes([PAGE_ID], b);
    assert.deepEqual(batch[PAGE_ID], { count: 1, liked: true });
    const anonymous = await likes.getReferenceLikes([PAGE_ID], null);
    assert.deepEqual(anonymous[PAGE_ID], { count: 1, liked: false });
  });

  await t.test("comments write only dr:ref:* keys and never dr:comments:*", async () => {
    const comment = await comments.addReferenceComment({
      threadId: PAGE_ID,
      author: "同行",
      content: "实测数据补一条",
      avatar: 3,
    });
    assert.equal(comment.threadId, PAGE_ID);

    assert.ok(hashes.has(`dr:ref:comments:${PAGE_ID}`), "reference hash must exist");
    assert.ok(sets.get("dr:ref:comments:index")?.has(PAGE_ID), "reference index must contain the id");
    assert.ok(!hashes.has(`dr:comments:${PAGE_ID}`), "diary hash must stay untouched");
    assert.ok(!sets.has("dr:comments:index"), "diary index must stay untouched");
    assert.ok(!strings.has("dr:comments:gen"), "diary gen must stay untouched");

    const { threads } = await comments.getReferenceCommentsMany([PAGE_ID]);
    assert.equal(threads[PAGE_ID].length, 1);
    assert.equal(threads[PAGE_ID][0].content, "实测数据补一条");

    const counts = await comments.getReferenceCommentCounts(new Set([PAGE_ID]));
    assert.equal(counts[PAGE_ID], 1);

    assert.equal(await comments.deleteReferenceComment(PAGE_ID, comment.id), true);
    assert.equal(hashes.get(`dr:ref:comments:${PAGE_ID}`).size, 0);
    assert.ok(strings.has("dr:ref:comments:gen"), "reference gen should advance on delete");
    assert.ok(!strings.has("dr:comments:gen"));
  });
});
