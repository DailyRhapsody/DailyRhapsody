// node --experimental-test-module-mocks --test tests/reference-store.test.mjs
//
// Reference 数据层的离线集成：只替换 Notion SDK 与 Upstash 两个外部边界，
// 真实走 lib/notion-reference.ts 的映射、缓存、签名与媒体归属逻辑。
// 重点守卫：
//  - Public 缺失必须 fail-closed
//  - 缓存里不能出现 Notion 签名 URL
//  - 缓存结构带 schemaVersion，旧结构视为未命中
//  - 正文图 / 封面走稳定代理路径，并记下 pageId 供媒体鉴权
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const PAGE_ID = "11111111-1111-1111-1111-111111111111";
const PAGE_PRIVATE = "22222222-2222-2222-2222-222222222222";
const DASHLESS_ID = PAGE_ID.replace(/-/g, "");
const IMAGE_BLOCK = "33333333333333333333333333333333";
const DATABASE = "44444444444444444444444444444444";

const richText = (text) => ({
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

const signedCover =
  "https://prod-files-secure.s3.us-west-2.amazonaws.com/cover.png?X-Amz-Signature=cover";
const signedPdf =
  "https://prod-files-secure.s3.us-west-2.amazonaws.com/report.pdf?X-Amz-Signature=pdf";
const signedImage =
  "https://prod-files-secure.s3.us-west-2.amazonaws.com/body.png?X-Amz-Signature=body";
const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function page(id, isPublic = true) {
  const properties = {
    Name: { type: "title", title: [richText(`条目 ${id.slice(0, 4)}`)] },
    URL: { type: "url", url: "https://example.com/report" },
    Source: { type: "select", select: { name: "arXiv" } },
    Tag: { type: "multi_select", multi_select: [{ name: "SLAM" }] },
    Type: { type: "select", select: { name: "实测报告" } },
    Domain: { type: "multi_select", multi_select: [{ name: "导航定位" }] },
    Year: { type: "number", number: 2025 },
    Summary: { type: "rich_text", rich_text: [richText("一句话结论")] },
    License: { type: "select", select: { name: "已授权" } },
    Copyright: { type: "rich_text", rich_text: [richText("© 2025 Example")] },
    Attachment: {
      type: "files",
      files: [{ type: "file", name: "report.pdf", file: { url: signedPdf, expiry_time: expiry } }],
    },
  };
  if (isPublic) properties.Public = { type: "checkbox", checkbox: true };
  return {
    object: "page",
    id,
    created_time: "2026-10-01T00:00:00.000Z",
    last_edited_time: "2026-10-02T00:00:00.000Z",
    archived: false,
    in_trash: false,
    cover: { type: "file", file: { url: signedCover, expiry_time: expiry } },
    properties,
  };
}

const pages = [page(PAGE_ID), page(PAGE_PRIVATE, false)];

test("reference store maps new properties, stores stable media paths, and fails closed", { timeout: 8000 }, async (t) => {
  const env = {
    NODE_ENV: "test",
    NOTION_TOKEN: "test-notion-token",
    NOTION_REFERENCE_DB_ID: DATABASE,
    UPSTASH_REDIS_REST_URL: "https://redis.test.invalid",
    UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  };
  const originalEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);

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

  const store = new Map();
  const read = (key) => structuredClone(store.get(key) ?? null);
  let queryCalls = 0;
  let retrieveCalls = 0;

  const query = t.mock.fn(async () => {
    queryCalls += 1;
    return { results: structuredClone(pages), has_more: false, next_cursor: null };
  });
  const retrieve = t.mock.fn(async ({ page_id }) => {
    retrieveCalls += 1;
    const hit = pages.find((p) => p.id === page_id);
    if (!hit) throw new Error("not found");
    return structuredClone(hit);
  });
  const children = t.mock.fn(async () => ({
    results: [
      {
        object: "block",
        id: "55555555555555555555555555555555",
        type: "paragraph",
        has_children: false,
        paragraph: { rich_text: [richText("正文")], color: "default" },
      },
      {
        object: "block",
        id: IMAGE_BLOCK,
        type: "image",
        has_children: false,
        image: { type: "file", file: { url: signedImage, expiry_time: expiry } },
      },
    ],
    has_more: false,
    next_cursor: null,
  }));

  t.mock.module("@notionhq/client", {
    namedExports: {
      Client: class {
        constructor({ auth }) {
          assert.equal(auth, "test-notion-token");
        }
        databases = { query };
        pages = { retrieve };
        blocks = { children: { list: children } };
      },
      APIResponseError: { isAPIResponseError: () => false },
      APIErrorCode: {},
      RequestTimeoutError: { isRequestTimeoutError: () => false },
    },
  });

  t.mock.module("@upstash/redis", {
    namedExports: {
      Redis: class {
        constructor({ url, token }) {
          assert.equal(url, env.UPSTASH_REDIS_REST_URL);
          assert.equal(token, "test-redis-token");
        }
        async get(key) {
          return read(key);
        }
        async mget(...keys) {
          const flat = keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys;
          return flat.map(read);
        }
        async set(key, value, options) {
          if (options?.nx && store.has(key)) return null;
          store.set(key, structuredClone(value));
          return "OK";
        }
        async eval(script, [key], [token]) {
          if (script.includes('redis.call("del"')) {
            return store.get(key) === token ? Number(store.delete(key)) : 0;
          }
          return 1;
        }
        async scan() {
          return ["0", []];
        }
        async del(...keys) {
          for (const key of keys) store.delete(key);
          return keys.length;
        }
        pipeline() {
          const ops = [];
          return {
            set(key, value, options) {
              ops.push({ key, value, options });
              return this;
            },
            async exec() {
              for (const op of ops) store.set(op.key, structuredClone(op.value));
              return ops.map(() => "OK");
            },
          };
        }
      },
    },
  });

  t.mock.module("@vercel/functions", {
    namedExports: { waitUntil: (task) => task },
  });

  const {
    getReferenceItems,
    getCachedReferenceItems,
    getReferenceItem,
    getReferenceMediaOwner,
    getReferenceBodyMediaOwner,
    getReferenceAttachmentUrl,
    REFERENCE_SCHEMA_VERSION,
  } = await import("../lib/notion-reference.ts");
  const { mediaVersion, mediaProxyPath } = await import("../lib/notion-media.ts");

  t.after(() => {
    hooks.deregister();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await t.test("maps properties and stores stable cover paths, not signed URLs", async () => {
    const items = await getReferenceItems();
    assert.equal(queryCalls, 1);
    assert.equal(items.length, 2);

    const item = items.find((x) => x.id === PAGE_ID);
    assert.ok(item);
    assert.equal(item.isPublic, true);
    assert.equal(item.kind, "test");
    assert.deepEqual(item.domains, ["导航定位"]);
    assert.equal(item.year, 2025);
    assert.equal(item.summary, "一句话结论");
    assert.equal(item.license, "authorized");
    assert.equal(item.copyright, "© 2025 Example");
    assert.equal(item.coverKind, "file");
    assert.equal(item.coverPath, mediaProxyPath("r", PAGE_ID, signedCover));
    assert.ok(!item.coverPath.includes("X-Amz"), "cover path must not contain a signature");
    assert.deepEqual(item.attachment, { kind: "file", name: "report.pdf" });

    const privateItem = items.find((x) => x.id === PAGE_PRIVATE);
    assert.ok(privateItem);
    assert.equal(privateItem.isPublic, false, "missing Public must fail closed");

    const cached = store.get("notion:reference:items:v2");
    assert.equal(cached.schemaVersion, REFERENCE_SCHEMA_VERSION);
    assert.ok(!JSON.stringify(cached).includes("X-Amz-Signature"), "signed URLs must not enter the list cache");
  });

  await t.test("detail body uses proxy paths and records media ownership", async () => {
    const item = await getReferenceItem(PAGE_ID);
    assert.ok(item);
    assert.ok(item.bodyMarkdown.includes(`/api/media/b/${IMAGE_BLOCK}/`));
    assert.ok(!item.bodyMarkdown.includes("X-Amz-Signature"));

    const version = mediaVersion(signedImage);
    const itemCache = store.get(`notion:reference:item:v2:${PAGE_ID}`);
    assert.equal(itemCache.schemaVersion, REFERENCE_SCHEMA_VERSION);
    assert.ok(!JSON.stringify(itemCache).includes("X-Amz-Signature"));

    const mediaKey = `dr:ref:media:${IMAGE_BLOCK}:${version}`;
    assert.equal(store.get(mediaKey), PAGE_ID);

    const owner = await getReferenceMediaOwner(DASHLESS_ID);
    assert.deepEqual(owner, { pageId: PAGE_ID, isPublic: true });
    const bodyOwner = await getReferenceBodyMediaOwner(IMAGE_BLOCK, version);
    assert.deepEqual(bodyOwner, { pageId: PAGE_ID, isPublic: true });
    assert.equal(await getReferenceBodyMediaOwner(IMAGE_BLOCK, "aaaaaaaaaa"), null);
  });

  await t.test("cached list is read-only and does not hit Notion", async () => {
    const before = queryCalls;
    const cached = await getCachedReferenceItems();
    assert.ok(cached);
    assert.equal(cached.length, 2);
    assert.equal(queryCalls, before);
  });

  await t.test("explicit invalidation fails closed for media and auth reads", async () => {
    const key = "notion:reference:items:invalidatedAt";
    const previous = store.get(key);
    store.set(key, Date.now() + 1000);
    try {
      assert.equal(await getCachedReferenceItems(), null);
      assert.equal(await getReferenceMediaOwner(DASHLESS_ID), null);
    } finally {
      if (previous === undefined) store.delete(key);
      else store.set(key, previous);
    }
  });

  await t.test("attachment URL is resolved from the page and cached by expiry", async () => {
    const before = retrieveCalls;
    const file = await getReferenceAttachmentUrl(PAGE_ID);
    assert.deepEqual(file, { url: signedPdf, name: "report.pdf" });
    assert.equal(retrieveCalls, before + 1);

    // 第二次走缓存，不再打 Notion
    const again = await getReferenceAttachmentUrl(PAGE_ID);
    assert.deepEqual(again, { url: signedPdf, name: "report.pdf" });
    assert.equal(retrieveCalls, before + 1);

    const cacheKey = `notion:reference:file:v2:${PAGE_ID}`;
    assert.equal(store.get(cacheKey).url, signedPdf);
  });
});
