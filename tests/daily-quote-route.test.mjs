import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Socket } from 'node:net';
import { test } from 'node:test';

/**
 * 每日一句接口：每天只生成一次、并发不重复计费、失败冷却、不合格输出不落盘、
 * 只用 public 人设包。全部离线，真实网络被守卫拦住。
 */
test('每日一句接口：生成一次、缓存一整天、失败冷却、公开包隔离（仅离线）', async t => {
  const hooks = registerHooks({ resolve(s, c, n) { return n(s === 'next/server' ? 'next/server.js' : s.startsWith('@/') ? new URL(`../${s.slice(2)}.ts`, import.meta.url).href : s, c); } });
  const blocked = () => { throw new Error('Real network forbidden'); };
  const fetchMock = t.mock.method(globalThis, 'fetch', blocked), connectMock = t.mock.method(Socket.prototype, 'connect', blocked);
  const env = { UPSTASH_REDIS_REST_URL: 'https://redis.test.invalid', UPSTASH_REDIS_REST_TOKEN: 'test-token', NEXT_PUBLIC_PET_MODE: 'public' };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    hooks.deregister();
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
  });

  const db = new Map();
  const exps = [];
  let modelCalls = 0, modelReply = '好的判断来自现场，而不是来自文档。', loadArgs = [], modelFails = false, configured = true;

  t.mock.module(new URL('../lib/persona/store.ts', import.meta.url).href, {
    namedExports: { loadPersona: async preferOwner => { loadArgs.push(preferOwner); return { tier: 'public', identity: '公开画像本人', voice: '直接', logic: '先看约束', memory: '在工厂待过', boundaries: '不谈家事', exemplars: [], notes: [], starters: [] }; } },
  });
  t.mock.module(new URL('../lib/persona/llm.ts', import.meta.url).href, {
    namedExports: {
      isLlmConfigured: () => configured,
      streamChat: async opts => {
        modelCalls++;
        assert.equal(opts.strict, true, '一句话也要等协议正常收尾');
        assert(opts.messages[0].content);
        if (modelFails) throw new Error('upstream down');
        const text = typeof modelReply === 'function' ? modelReply() : modelReply;
        return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
      },
    },
  });
  t.mock.module('@upstash/redis', { namedExports: { Redis: class {
    async get(k) { return db.has(k) ? structuredClone(db.get(k)) : null; }
    async set(k, v, opts) {
      if (opts?.nx && db.has(k)) return null;
      db.set(k, structuredClone(v));
      if (typeof opts?.ex === 'number') exps.push([k, opts.ex]);
      return 'OK';
    }
    async eval(_, [key], [token]) { return db.get(key) === token ? Number(db.delete(key)) : 0; }
  } } });
  t.mock.module(new URL('../lib/request-guard.ts', import.meta.url).href, {
    namedExports: { guardApiRequest: async () => null, withAntiScrapeHeaders: r => r },
  });

  const { GET } = await import('../app/api/persona/daily-quote/route.ts');
  const { dailyQuoteKey, dailyQuoteLockKey, todayInBeijing } = await import('../lib/persona/daily-quote.ts');
  const date = todayInBeijing();
  const call = () => GET(new Request('http://local.test/api/persona/daily-quote'));
  const reset = () => {
    db.clear(); exps.length = 0; modelCalls = 0; modelReply = '好的判断来自现场，而不是来自文档。';
    loadArgs = []; modelFails = false; configured = true; process.env.NEXT_PUBLIC_PET_MODE = 'public';
  };

  await t.test('首次生成并写缓存；同一天后续请求只读缓存', async () => {
    reset();
    const first = await call();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { date, text: '好的判断来自现场，而不是来自文档。' });
    assert.equal(modelCalls, 1);
    assert.deepEqual(loadArgs, [false], '只能用 public 包，不能顺手取 owner');
    const cached = db.get(dailyQuoteKey(date));
    assert.equal(typeof cached, 'string');
    const ttl = exps.find(([k]) => k === dailyQuoteKey(date))?.[1] ?? 0;
    assert(ttl > 3_600 && ttl <= 86_400 + 3_600, `TTL 应到次日零点，实际 ${ttl}`);
    const second = await call();
    assert.equal(second.status, 200);
    assert.equal(modelCalls, 1, '缓存命中不该再生成');
    // 生成用的锁在 finally 里释放
    assert.equal(db.has(dailyQuoteLockKey(date)), false);
  });

  await t.test('并发：锁被别的实例占着时不排队、不调用模型', async () => {
    reset();
    db.set(dailyQuoteLockKey(date), 'other-instance');
    const res = await call();
    assert.equal(res.status, 204);
    assert.equal(modelCalls, 0);
    assert.equal(db.has(dailyQuoteLockKey(date)), true, '不能替别人释放锁');
  });

  await t.test('模型失败：返回 204 并冷却，冷却期内不再重试', async () => {
    reset();
    modelFails = true;
    assert.equal((await call()).status, 204);
    assert.equal(modelCalls, 1);
    assert.equal(db.get(`${dailyQuoteKey(date)}:cooldown`), '1');
    assert.equal(db.has(dailyQuoteKey(date)), false, '失败不写句子');
    assert.equal((await call()).status, 204);
    assert.equal(modelCalls, 1, '冷却期内不该再烧模型调用');
  });

  await t.test('不合格输出不落盘，同样进冷却', async () => {
    reset();
    modelReply = '抱歉，我不能写这句话。';
    assert.equal((await call()).status, 204);
    assert.equal(modelCalls, 1);
    assert.equal(db.has(dailyQuoteKey(date)), false);
    assert.equal(db.get(`${dailyQuoteKey(date)}:cooldown`), '1');
  });

  await t.test('重试成功后写入缓存', async () => {
    reset();
    modelReply = '先把约束写清楚，再谈方案。';
    assert.equal((await call()).status, 200);
    assert.equal(db.get(dailyQuoteKey(date)), '先把约束写清楚，再谈方案。');
  });

  await t.test('模型未配置时静默关闭：204，且不加锁', async () => {
    reset();
    configured = false;
    assert.equal((await call()).status, 204);
    assert.equal(modelCalls, 0);
    assert.equal(db.has(dailyQuoteLockKey(date)), false);
  });

  await t.test('数字人关闭时接口不存在', async () => {
    reset();
    process.env.NEXT_PUBLIC_PET_MODE = 'off';
    const res = await call();
    assert.equal(res.status, 404);
    assert.equal(modelCalls, 0);
  });
});
