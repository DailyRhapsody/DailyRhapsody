import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Socket } from 'node:net';
import { test } from 'node:test';

/** 命名空间是本 skill 与第一个 skill 的唯一隔离点，测试里当常量锁住 */
const PREFIX = 'dr:blog:core-values:v1:test';

test('核心价值观接口：分批、缓存、并发、撤回、拒答与命名空间隔离（仅离线）', async t => {
  const hooks = registerHooks({ resolve(s, c, n) { return n(s === 'next/server' ? 'next/server.js' : s.startsWith('@/') ? new URL(`../${s.slice(2)}.ts`, import.meta.url).href : s, c); } });
  const blocked = () => { throw new Error('Real network forbidden'); };
  const fetch = t.mock.method(globalThis, 'fetch', blocked), connect = t.mock.method(Socket.prototype, 'connect', blocked);
  const env = { UPSTASH_REDIS_REST_URL: 'https://redis.test.invalid', UPSTASH_REDIS_REST_TOKEN: 'test-token', VERCEL_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  t.after(() => { hooks.deregister(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } assert.equal(fetch.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0); });

  const db = new Map(), writes = [];
  let sourceCalls = 0, modelCalls = 0, authorizeCalls = 0, gate;
  let changeDuringModel = false, broken = false, refuseMark = null;
  const make = (id, text = `证据${id}：宁可慢一点，也不把判断交给别人。`) => ({ id, date: '2026-10-08', summary: text, isPublic: true, bodyStatus: 'complete' });
  let diaries = [make('a'), make('b')];

  t.mock.module(new URL('../lib/notion.ts', import.meta.url).href, { namedExports: { getAnalysisDiaries: async () => { sourceCalls++; return diaries === null ? null : structuredClone(diaries); } } });
  t.mock.module(new URL('../lib/request-guard.ts', import.meta.url).href, { namedExports: { withAntiScrapeHeaders: r => r } });
  t.mock.module('@upstash/redis', { namedExports: { Redis: class {
    async mget(...keys) { return keys.map(k => structuredClone(db.get(k) ?? null)); }
    async set(k, v, opts) { if (opts?.nx && db.has(k)) return null; db.set(k, structuredClone(v)); return 'OK'; }
    pipeline() { const queued = []; return { set(k, v) { queued.push([k, v]); return this; }, async exec() { for (const [k, v] of queued) { db.set(k, structuredClone(v)); writes.push(k); } return queued.map(() => 'OK'); } }; }
    async eval(_, [key], [token]) { return db.get(key) === token ? Number(db.delete(key)) : 0; }
  } } });
  t.mock.module(new URL('../lib/persona/llm.ts', import.meta.url).href, { namedExports: { streamChat: async opts => {
    modelCalls++; assert.equal(opts.strict, true); assert(opts.signal); if (gate) await gate.promise;
    const input = JSON.parse(opts.messages[0].content);
    const refused = refuseMark && Array.isArray(input) && input.some(c => typeof c.text === 'string' && c.text.includes(refuseMark));
    if (refused) throw new Error('Content Exists Risk (request_id: test)');
    const raw = Array.isArray(input)
      ? input.map(c => ({ key: c.key, findings: [{ kind: 'tradeoff', claim: '为独立判断让渡效率。', evidence: [{ chunk: c.key, quote: c.text.slice(-60) }], boundary: '仅据文本归纳。' }] }))
      : { findings: input.notes.flatMap(n => n.findings).slice(0, 8) };
    if (changeDuringModel) diaries = diaries.filter(d => d.id !== 'a');
    return new ReadableStream({ start(c) { if (broken) { c.error(new Error('interrupted')); return; } c.enqueue(new TextEncoder().encode(JSON.stringify(raw))); c.close(); } });
  } } });

  const { runCoreValues } = await import('../lib/persona/core-values-route.ts');
  const { makeValuesCorpus } = await import('../lib/persona/core-values.ts');
  const request = () => new Request('http://local.test/api/chat', { method: 'POST', body: '{}' });
  const auth = async () => { authorizeCalls++; return null; };
  const run = () => runCoreValues(request(), auth);
  const skipKeys = () => [...db.keys()].filter(k => k.includes(':skip:'));
  const reset = () => { db.clear(); writes.length = 0; diaries = [make('a'), make('b')]; modelCalls = 0; authorizeCalls = 0; changeDuringModel = false; broken = false; gate = undefined; refuseMark = null; };

  await t.test('202提炼→最终报告→缓存命中；缓存不消耗模型额度', async () => {
    reset(); assert.equal((await run()).status, 202);
    const report = await run();
    assert.equal(report.status, 200);
    const text = await report.text();
    assert(text.includes('2 篇公开文章'));
    assert(text.includes('### 价值排序（取舍与代价）'), '取舍章节必须出现');
    assert(text.includes('/blog#entry-a'), '链接由服务器生成');
    assert.equal(modelCalls, 2); assert.equal(authorizeCalls, 2);
    assert.equal((await run()).status, 200); assert.equal(modelCalls, 2);
    assert(sourceCalls >= 6, '发布前必须重读来源');
  });

  await t.test('缓存键全部落在自己的命名空间，不与第一个 skill 共用', async () => {
    reset(); await run(); await run();
    const keys = [...db.keys()];
    assert(keys.length > 0);
    assert(keys.every(k => k.startsWith(`${PREFIX}:`)), `越界键：${keys.filter(k => !k.startsWith(`${PREFIX}:`)).join(',')}`);
    assert(!keys.some(k => k.includes('first-principles')), '两个 skill 的缓存不得互相污染');
    assert(keys.some(k => k.endsWith('build-lock')) === false, '锁必须释放');
  });

  await t.test('失效快照不返回缓存报告', async () => {
    diaries = null;
    const r = await run();
    assert.equal(r.status, 202); assert.equal((await r.json()).phase, 'sources'); assert.equal(modelCalls, 2);
  });

  await t.test('生成中撤回公开文章：既不写旧依据也不发布', async () => {
    reset(); changeDuringModel = true;
    const r = await run();
    assert.equal(r.status, 202); assert.equal((await r.json()).phase, 'sources'); assert.equal(writes.length, 0);
  });

  await t.test('模型中断不提交，下一次从已完成进度继续', async () => {
    reset(); broken = true;
    await assert.rejects(run());
    assert.equal(writes.length, 0);
    assert(![...db.keys()].some(k => k.endsWith('build-lock')), '锁必须释放');
    broken = false;
    assert.equal((await run()).status, 202);
  });

  await t.test('并发点击只触发一次模型调用', async () => {
    reset(); gate = Promise.withResolvers();
    const one = run(); while (!modelCalls) await new Promise(r => setImmediate(r));
    const two = await run();
    assert.equal(two.status, 202); assert.equal(modelCalls, 1);
    gate.resolve(); await one; assert.equal(modelCalls, 1);
  });

  await t.test('额度拒绝不调用模型且释放锁', async () => {
    reset();
    const r = await runCoreValues(request(), async () => new Response('quota', { status: 429 }));
    assert.equal(r.status, 429); assert.equal(modelCalls, 0); assert.equal(db.size, 0);
  });

  await t.test('一次拒答只标记真正被拒的那一个切块，报告声明 1 篇', async () => {
    reset();
    refuseMark = '【触发拒答的段落】';
    diaries = Array.from({ length: 12 }, (_, i) => make(`k${String(i).padStart(2, '0')}`, `第 ${i} 篇：宁可慢一点，也不把判断交给别人。`));
    diaries[11].summary += refuseMark;
    const corpus = makeValuesCorpus(structuredClone(diaries));
    const guilty = corpus.chunks.find(c => c.text.includes(refuseMark));
    assert(guilty, '材料里必须正好有一个切块会触发拒答');
    assert.equal(corpus.chunks.length, 12, '12 篇短文正好是一个 12 块的提炼批次');
    assert.equal((await run()).status, 202);
    assert.equal(skipKeys().length, 1, `只该标记真正被拒的那一块，实际 ${skipKeys().length} 块`);
    assert(skipKeys()[0].endsWith(`:skip:${guilty.key}`));
    assert(modelCalls >= 2 && modelCalls <= 9, `二分探测有上界，实际 ${modelCalls}`);
    let report = null;
    for (let round = 0; round < 6 && !report; round++) { const r = await run(); if (r.status === 200) report = await r.text(); }
    assert.ok(report, '被拒切块标记后必须能走到报告');
    assert.match(report, /另有 1 篇的部分正文被模型供应商的内容策略拒绝处理/);
    assert(report.includes('12 篇公开文章'));
  });
});
