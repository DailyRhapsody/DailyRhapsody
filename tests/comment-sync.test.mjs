// node --experimental-test-module-mocks --test tests/comment-sync.test.mjs
//
// 评论双向同步：验签、事件过滤、幂等、正向创建/删除、待补重试。
//
// 只替换三个边界（评论存储、文章缓存、站点资料）和全局 fetch，同步逻辑本身走真实实现，
// 要检出的是「伪造事件能写进博客」「bot 自己的评论造成循环」「重复投递写两条」这类问题。
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";
import { test } from "node:test";

const PAGE_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_ID = "user-owner";
const SECRET = "secret_test_123";

process.env.NOTION_TOKEN = "test-token";
process.env.NOTION_WEBHOOK_SECRET = SECRET;
process.env.NOTION_OWNER_USER_ID = OWNER_ID;

/** 内存版 Redis：只实现同步用到的几个命令 */
function makeRedis() {
  const kv = new Map();
  const zsets = new Map();
  return {
    kv,
    zsets,
    async get(key) {
      const hit = kv.get(key);
      if (!hit) return null;
      if (hit.exp && hit.exp < Date.now()) {
        kv.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key, value, opts = {}) {
      const hit = kv.get(key);
      if (opts.nx && hit && (!hit.exp || hit.exp > Date.now())) return null;
      kv.set(key, { value, exp: opts.ex ? Date.now() + opts.ex * 1000 : 0 });
      return "OK";
    },
    async del(key) {
      return kv.delete(key) ? 1 : 0;
    },
    async zadd(key, item) {
      const set = zsets.get(key) ?? new Map();
      set.set(item.member, item.score);
      zsets.set(key, set);
      return 1;
    },
    async zrange(key, start, stop, opts = {}) {
      const set = zsets.get(key) ?? new Map();
      const now = typeof stop === "number" ? stop : Number.MAX_SAFE_INTEGER;
      const rows = [...set.entries()]
        .filter(([, score]) => (opts.byScore ? score <= now : true))
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
      const offset = opts.offset ?? 0;
      const count = opts.count ?? rows.length;
      return rows.slice(offset, offset + count);
    },
    async zrem(key, member) {
      const set = zsets.get(key);
      if (!set) return 0;
      return set.delete(member) ? 1 : 0;
    },
  };
}

function freshEnv() {
  globalThis.__SYNC_ENV__ = {
    redis: makeRedis(),
    comments: new Map(), // `${diaryId}:${id}` -> comment
    diaries: [{ id: PAGE_ID, isPublic: true }],
    calls: [],
    nextId: 1,
  };
  return globalThis.__SYNC_ENV__;
}

function registerMocks() {
  return registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "next/server") return next("next/server.js", context);
      const fromSync = context.parentURL?.includes("/lib/comment-sync.ts");
      if (specifier === "./comments-store" && fromSync) {
        return { url: "mock:comments-store", shortCircuit: true, format: "module" };
      }
      if (specifier === "./notion" && fromSync) {
        return { url: "mock:notion", shortCircuit: true, format: "module" };
      }
      if (specifier === "./profile-store" && fromSync) {
        return { url: "mock:profile-store", shortCircuit: true, format: "module" };
      }
      return next(
        specifier.startsWith("@/") ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier,
        context
      );
    },
    load(url, context, next) {
      if (url === "mock:comments-store") {
        return {
          format: "module",
          shortCircuit: true,
          source: `
export const getCommentsRedis = () => globalThis.__SYNC_ENV__.redis;
export async function getComment(diaryId, commentId) {
  const c = globalThis.__SYNC_ENV__.comments.get(diaryId + ":" + commentId);
  if (!c) return null;
  const nid = globalThis.__SYNC_ENV__.redis.kv.get("dr:comment-notion-id:" + diaryId + ":" + commentId)?.value;
  return { ...c, ...(typeof nid === "string" && nid ? { notionCommentId: nid } : {}) };
}
export async function addComment(input) {
  const id = "c" + globalThis.__SYNC_ENV__.nextId++;
  const comment = { ...input, id, createdAt: new Date().toISOString() };
  globalThis.__SYNC_ENV__.comments.set(input.diaryId + ":" + id, comment);
  return comment;
}
export async function deleteComment(diaryId, commentId) {
  globalThis.__SYNC_ENV__.redis.kv.delete("dr:comment-notion-id:" + diaryId + ":" + commentId);
  return globalThis.__SYNC_ENV__.comments.delete(diaryId + ":" + commentId);
}
export async function setNotionCommentId(diaryId, commentId, notionId) {
  const key = diaryId + ":" + commentId;
  if (!globalThis.__SYNC_ENV__.comments.has(key)) return false;
  globalThis.__SYNC_ENV__.redis.kv.set("dr:comment-notion-id:" + key, { value: notionId, exp: 0 });
  return true;
}
export async function updateCommentContent(diaryId, commentId, content) {
  const key = diaryId + ":" + commentId;
  const c = globalThis.__SYNC_ENV__.comments.get(key);
  if (!c) return false;
  globalThis.__SYNC_ENV__.comments.set(key, { ...c, content });
  return true;
}
`,
        };
      }
      if (url === "mock:notion") {
        return {
          format: "module",
          shortCircuit: true,
          source: `export const getCachedDiaries = async () => globalThis.__SYNC_ENV__.diaries;`,
        };
      }
      if (url === "mock:profile-store") {
        return {
          format: "module",
          shortCircuit: true,
          source: `export const getProfile = async () => ({ name: "滕君" });`,
        };
      }
      return next(url, context);
    },
  });
}

const hooks = registerMocks();
const sync = await import("../lib/comment-sync.ts");

/** 造一条 Notion 事件 */
function makeEvent(type, overrides = {}) {
  const env = globalThis.__SYNC_ENV__;
  return {
    id: overrides.id ?? `evt-${env.nextId++}`,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    type,
    authors: overrides.authors ?? [{ id: OWNER_ID, type: "person" }],
    entity: { id: overrides.commentId ?? "notion-comment-1", type: "comment" },
    data: {
      page_id: overrides.pageId ?? PAGE_ID,
      parent: { id: overrides.pageId ?? PAGE_ID, type: overrides.parentType ?? "page" },
    },
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    globalThis.__SYNC_ENV__.calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("验签：正确签名通过，篡改/错误密钥/格式不对一律拒绝", () => {
  const raw = JSON.stringify({ hello: "world" });
  const good = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  assert.equal(sync.verifyNotionSignature(raw, good, SECRET), true);
  assert.equal(sync.verifyNotionSignature(raw + " ", good, SECRET), false);
  assert.equal(sync.verifyNotionSignature(raw, "sha256=deadbeef", SECRET), false);
  assert.equal(sync.verifyNotionSignature(raw, "md5=abc", SECRET), false);
  const wrong = "sha256=" + createHmac("sha256", "other").update(raw).digest("hex");
  assert.equal(sync.verifyNotionSignature(raw, wrong, SECRET), false);
});

test("事件解析：块级评论与多作者直接丢掉", () => {
  freshEnv();
  assert.equal(sync.parseNotionEvent(makeEvent("comment.created", { parentType: "block" })), null);
  assert.equal(sync.parseNotionEvent(makeEvent("comment.created", { authors: [{ id: "a", type: "person" }, { id: "b", type: "person" }] })), null);
  assert.equal(sync.parseNotionEvent(makeEvent("page.created")), null);
  const ok = sync.parseNotionEvent(makeEvent("comment.created"));
  assert.equal(ok.pageId, PAGE_ID);
  assert.equal(ok.commentId, "notion-comment-1");
});

test("正文：昵称在前，站长用站点名，超长截断", () => {
  assert.equal(
    sync.buildCommentText({ id: "1", diaryId: PAGE_ID, author: "小明", content: "你好", createdAt: "" }, "滕君"),
    "小明：你好"
  );
  assert.equal(
    sync.buildCommentText({ id: "1", diaryId: PAGE_ID, author: "小明", content: "你好", createdAt: "", isAuthor: true }, "滕君"),
    "滕君：你好"
  );
  const long = sync.buildCommentText({ id: "1", diaryId: PAGE_ID, author: "小明", content: "字".repeat(3000), createdAt: "" }, "滕君");
  assert.equal(long.length, 2000);
});

test("bot 自己的评论被忽略，不会循环写回博客", async () => {
  const env = freshEnv();
  // 作者 id 用白名单里的那个人，只有 type=bot 这一层能挡住它，避免双重防护掩盖过滤失效
  const restore = stubFetch(() => jsonResponse({ rich_text: [{ plain_text: "不该出现" }] }));
  const result = await sync.handleNotionCommentEvent(
    makeEvent("comment.created", { authors: [{ id: OWNER_ID, type: "bot" }] })
  );
  assert.equal(result, "ignored");
  assert.equal(env.comments.size, 0);
  restore();
});

test("非白名单成员被忽略", async () => {
  const env = freshEnv();
  const restore = stubFetch(() => jsonResponse({ rich_text: [{ plain_text: "不该出现" }] }));
  const result = await sync.handleNotionCommentEvent(
    makeEvent("comment.created", { authors: [{ id: "someone-else", type: "person" }] })
  );
  assert.equal(result, "ignored");
  assert.equal(env.comments.size, 0);
  restore();
});

test("事件级幂等：同一 event.id 换个 comment 重投，仍然只处理第一条", async () => {
  const env = freshEnv();
  const restore = stubFetch(() => jsonResponse({ id: "notion-x", rich_text: [{ plain_text: "第一条" }] }));
  assert.equal(
    await sync.handleNotionCommentEvent(makeEvent("comment.created", { id: "evt-dup", commentId: "comment-a" })),
    "handled"
  );
  assert.equal(
    await sync.handleNotionCommentEvent(makeEvent("comment.created", { id: "evt-dup", commentId: "comment-b" })),
    "ignored"
  );
  assert.equal(env.comments.size, 1);
  restore();
});

test("作者在 Notion 新增评论：写进博客并标作者，同一 comment 重复投递只写一条", async () => {
  const env = freshEnv();
  const restore = stubFetch(() => jsonResponse({ id: "notion-comment-1", rich_text: [{ plain_text: "来自 Notion 的回复" }] }));
  assert.equal(await sync.handleNotionCommentEvent(makeEvent("comment.created", { id: "evt-1" })), "handled");
  assert.equal(env.comments.size, 1);
  const only = [...env.comments.values()][0];
  assert.equal(only.content, "来自 Notion 的回复");
  assert.equal(only.isAuthor, true);
  assert.equal(
    env.redis.kv.get(`dr:comment-notion-id:${PAGE_ID}:${only.id}`)?.value,
    "notion-comment-1"
  );
  // 不同 event.id、同一个 comment：应被映射键挡住
  assert.equal(await sync.handleNotionCommentEvent(makeEvent("comment.created", { id: "evt-2" })), "ignored");
  assert.equal(env.comments.size, 1);
  restore();
});

test("作者在 Notion 删除评论：博客同步删除并留 tombstone", async () => {
  const env = freshEnv();
  env.comments.set(`${PAGE_ID}:c9`, {
    id: "c9",
    diaryId: PAGE_ID,
    author: "滕君",
    content: "待删",
    createdAt: new Date().toISOString(),
    isAuthor: true,
    notionCommentId: "notion-comment-1",
  });
  env.redis.kv.set(`dr:comment-notion:notion-comment-1`, { value: "c9", exp: 0 });
  const restore = stubFetch(() => jsonResponse({}));
  assert.equal(await sync.handleNotionCommentEvent(makeEvent("comment.deleted")), "handled");
  assert.equal(env.comments.size, 0);
  assert.equal(await env.redis.get("dr:comment-notion:notion-comment-1"), "deleted");
  restore();
});

test("作者在 Notion 编辑评论：正文更新，条数不变", async () => {
  const env = freshEnv();
  env.comments.set(`${PAGE_ID}:c9`, {
    id: "c9",
    diaryId: PAGE_ID,
    author: "滕君",
    content: "旧内容",
    createdAt: new Date().toISOString(),
    isAuthor: true,
    notionCommentId: "notion-comment-1",
  });
  env.redis.kv.set(`dr:comment-notion:notion-comment-1`, { value: "c9", exp: 0 });
  const restore = stubFetch(() => jsonResponse({ rich_text: [{ plain_text: "新内容" }] }));
  assert.equal(await sync.handleNotionCommentEvent(makeEvent("comment.updated")), "handled");
  assert.equal([...env.comments.values()][0].content, "新内容");
  assert.equal(env.comments.size, 1);
  restore();
});

test("正向同步：创建成功回写 notionCommentId 并建映射", async () => {
  const env = freshEnv();
  env.comments.set(`${PAGE_ID}:c1`, {
    id: "c1",
    diaryId: PAGE_ID,
    author: "小明",
    content: "博客里的评论",
    createdAt: new Date().toISOString(),
  });
  const restore = stubFetch((url) => {
    if (url.endsWith("/comments")) return jsonResponse({ id: "notion-created-1" });
    return jsonResponse({});
  });
  await sync.syncCreatedComment(PAGE_ID, env.comments.get(`${PAGE_ID}:c1`));
  assert.equal(env.redis.kv.get(`dr:comment-notion-id:${PAGE_ID}:c1`)?.value, "notion-created-1");
  assert.equal(await env.redis.get("dr:comment-notion:notion-created-1"), "c1");
  const body = JSON.parse(env.calls[0].init.body);
  assert.equal(body.parent.page_id, PAGE_ID);
  assert.equal(body.rich_text[0].text.content, "小明：博客里的评论");
  restore();
});

test("正向同步：Notion 失败进待补队列，评论本身不受影响", async () => {
  const env = freshEnv();
  env.comments.set(`${PAGE_ID}:c1`, {
    id: "c1",
    diaryId: PAGE_ID,
    author: "小明",
    content: "会失败的同步",
    createdAt: new Date().toISOString(),
  });
  const restore = stubFetch(() => jsonResponse({ error: "boom" }, 500));
  await sync.syncCreatedComment(PAGE_ID, env.comments.get(`${PAGE_ID}:c1`));
  assert.equal(env.redis.kv.get(`dr:comment-notion-id:${PAGE_ID}:c1`), undefined);
  assert.equal(env.redis.zsets.get("dr:comment-sync:pending")?.size, 1);
  restore();
});

test("删除同步：Notion 404 视为已完成，不重复入队", async () => {
  const env = freshEnv();
  const restore = stubFetch(() => jsonResponse({ error: "not found" }, 404));
  await sync.syncDeletedComment({
    id: "c1",
    diaryId: PAGE_ID,
    author: "小明",
    content: "x",
    createdAt: new Date().toISOString(),
    notionCommentId: "notion-1",
  });
  assert.equal(env.redis.zsets.get("dr:comment-sync:pending")?.size ?? 0, 0);
  restore();
});

test("待补队列：重试成功后清空", async () => {
  const env = freshEnv();
  env.comments.set(`${PAGE_ID}:c1`, {
    id: "c1",
    diaryId: PAGE_ID,
    author: "小明",
    content: "稍后补上",
    createdAt: new Date().toISOString(),
  });
  env.redis.zadd("dr:comment-sync:pending", {
    score: Date.now() - 1000,
    member: JSON.stringify({ action: "create", diaryId: PAGE_ID, commentId: "c1", attempts: 0 }),
  });
  const restore = stubFetch(() => jsonResponse({ id: "notion-later-1" }));
  const done = await sync.drainPending(10);
  assert.equal(done, 1);
  assert.equal(env.redis.kv.get(`dr:comment-notion-id:${PAGE_ID}:c1`)?.value, "notion-later-1");
  assert.equal(env.redis.zsets.get("dr:comment-sync:pending")?.size ?? 0, 0);
  restore();
});


test("没有配置作者 id 时拒绝处理，避免任意成员冒充作者", async () => {
  const env = freshEnv();
  const restore = stubFetch(() => jsonResponse({ rich_text: [{ plain_text: "不该出现" }] }));
  delete process.env.NOTION_OWNER_USER_ID;
  try {
    const result = await sync.handleNotionCommentEvent(makeEvent("comment.created"));
    assert.equal(result, "ignored");
    assert.equal(env.comments.size, 0);
  } finally {
    process.env.NOTION_OWNER_USER_ID = OWNER_ID;
  }
  restore();
});

test("处理失败会释放事件键，Notion 重投时能再处理", async () => {
  const env = freshEnv();
  let fail = true;
  const restore = stubFetch(() =>
    fail ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ rich_text: [{ plain_text: "补上了" }] })
  );
  assert.equal(await sync.handleNotionCommentEvent(makeEvent("comment.created", { id: "evt-retry" })), "retry");
  assert.equal(await env.redis.get("dr:notion-event:evt-retry"), null);
  fail = false;
  assert.equal(await sync.handleNotionCommentEvent(makeEvent("comment.created", { id: "evt-retry" })), "handled");
  assert.equal(env.comments.size, 1);
  restore();
});

test("时间戳缺失或来自未来直接丢掉", async () => {
  freshEnv();
  assert.equal(sync.parseNotionEvent({ ...makeEvent("comment.created"), timestamp: undefined }), null);
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  assert.equal(await sync.handleNotionCommentEvent(makeEvent("comment.created", { timestamp: future })), "ignored");
});

test("created 与 deleted 竞态：删除先到，创建完成后不留下评论", async () => {
  const env = freshEnv();
  const restore = stubFetch(() => jsonResponse({ rich_text: [{ plain_text: "竞态" }] }));
  // 先把映射写成 tombstone，模拟删除事件已经落库
  await env.redis.set(`dr:comment-notion:notion-comment-1`, "deleted", { ex: 60 });
  const result = await sync.handleNotionCommentEvent(makeEvent("comment.created"));
  assert.equal(result, "ignored");
  assert.equal(env.comments.size, 0);
  restore();
});


test("创建处理期间删除事件先到：不再写入评论", async () => {
  const env = freshEnv();
  const restore = stubFetch(async () => {
    // 模拟 fetch 评论期间，deleted 事件已经把映射改成 tombstone
    await env.redis.set("dr:comment-notion:notion-comment-1", "deleted", { ex: 60 });
    return jsonResponse({ rich_text: [{ plain_text: "不该写入" }] });
  });
  const result = await sync.handleNotionCommentEvent(makeEvent("comment.created"));
  assert.equal(result, "ignored");
  assert.equal(env.comments.size, 0);
  restore();
});


test("未配置 secret 时，订阅验证请求仍然 200", async () => {
  delete process.env.NOTION_WEBHOOK_SECRET;
  const { POST } = await import("../app/api/notion/webhook/route.ts");
  const res = await POST(
    new Request("https://example.com/api/notion/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verification_token: "tok" }),
    })
  );
  assert.equal(res.status, 200);
  process.env.NOTION_WEBHOOK_SECRET = SECRET;
});

test("未配置 secret 时，普通事件仍然 503", async () => {
  delete process.env.NOTION_WEBHOOK_SECRET;
  const { POST } = await import("../app/api/notion/webhook/route.ts");
  const res = await POST(
    new Request("https://example.com/api/notion/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "e1", type: "comment.created" }),
    })
  );
  assert.equal(res.status, 503);
  process.env.NOTION_WEBHOOK_SECRET = SECRET;
});

test.after(() => hooks.deregister?.());
