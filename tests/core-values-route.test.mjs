import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Socket } from 'node:net';
import { test } from 'node:test';

/**
 * 命名空间前的 skill 段是本 skill 与第一个 skill 的唯一隔离点（版本号两边取值相同、
 * 同一篇文章的切块键实测逐字节一致），测试里当常量锁住；改提示词或校验要换版本号。
 */
const PREFIX = 'dr:blog:core-values:v2:test';

test('核心价值观接口：分批、缓存、并发、撤回、拒答与命名空间隔离（仅离线）', async t => {
  const hooks = registerHooks({ resolve(s, c, n) { return n(s === 'next/server' ? 'next/server.js' : s.startsWith('@/') ? new URL(`../${s.slice(2)}.ts`, import.meta.url).href : s, c); } });
  const blocked = () => { throw new Error('Real network forbidden'); };
  const fetch = t.mock.method(globalThis, 'fetch', blocked), connect = t.mock.method(Socket.prototype, 'connect', blocked);
  const env = { UPSTASH_REDIS_REST_URL: 'https://redis.test.invalid', UPSTASH_REDIS_REST_TOKEN: 'test-token', VERCEL_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  t.after(() => { hooks.deregister(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } assert.equal(fetch.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0); });

  const db = new Map(), writes = [], tokens = [];
  let sourceCalls = 0, modelCalls = 0, authorizeCalls = 0, gate;
  let changeDuringModel = false, broken = false, refuseMark = null, refuseMode = 'throw', networkFailAt = 0, batchOnlyRefusal = false, pipelineBroken = false;
  const make = (id, text = `证据${id}：宁可慢一点，也不把判断交给别人。`) => ({ id, date: '2026-10-08', summary: text, isPublic: true, bodyStatus: 'complete' });
  let diaries = [make('a'), make('b')];

  t.mock.module(new URL('../lib/notion.ts', import.meta.url).href, { namedExports: { getAnalysisDiaries: async () => { sourceCalls++; return diaries === null ? null : structuredClone(diaries); } } });
  t.mock.module(new URL('../lib/request-guard.ts', import.meta.url).href, { namedExports: { withAntiScrapeHeaders: r => r } });
  t.mock.module('@upstash/redis', { namedExports: { Redis: class {
    async mget(...keys) { return keys.map(k => structuredClone(db.get(k) ?? null)); }
    async set(k, v, opts) { if (opts?.nx && db.has(k)) return null; db.set(k, structuredClone(v)); return 'OK'; }
    pipeline() { const queued = []; return { set(k, v) { queued.push([k, v]); return this; }, async exec() { if (pipelineBroken) throw new Error('redis pipeline failed'); for (const [k, v] of queued) { db.set(k, structuredClone(v)); writes.push(k); } return queued.map(() => 'OK'); } }; }
    async eval(_, [key], [token]) { return db.get(key) === token ? Number(db.delete(key)) : 0; }
  } } });
  t.mock.module(new URL('../lib/persona/llm.ts', import.meta.url).href, { namedExports: { streamChat: async opts => {
    modelCalls++; tokens.push(opts.maxTokens); assert.equal(opts.strict, true); assert(opts.signal); if (gate) await gate.promise;
    // 网络、超时一类非拒答失败：必须与拒答区分开，否则会被当成拒答继续烧探测调用
    if (networkFailAt && modelCalls === networkFailAt) throw new Error('network down');
    const input = JSON.parse(opts.messages[0].content);
    const refused = (refuseMark && Array.isArray(input) && input.some(c => typeof c.text === 'string' && c.text.includes(refuseMark)))
      || (batchOnlyRefusal && Array.isArray(input) && input.length >= 12);
    if (refused) {
      const e = new Error('Content Exists Risk (request_id: test)');
      // 拒答既可能在建立连接时抛出，也可能在读流期间才到：两种形态都要能收敛
      if (refuseMode === 'stream') return new ReadableStream({ start(c) { c.error(e); } });
      throw e;
    }
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
  const lockKeys = () => [...db.keys()].filter(k => k.endsWith('build-lock'));
  const reset = () => { db.clear(); writes.length = 0; tokens.length = 0; diaries = [make('a'), make('b')]; modelCalls = 0; authorizeCalls = 0; changeDuringModel = false; broken = false; gate = undefined; refuseMark = null; refuseMode = 'throw'; networkFailAt = 0; batchOnlyRefusal = false; pipelineBroken = false; };

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

  await t.test('最终层用更高的输出预算，提炼层维持原档', async () => {
    // 条数上限与输出预算是配套的一档：8 条满字段约 1.06 万字符，6144 token 会被截断成
    // 「模型未完整返回分析结果」，而这条错误不被拒答识别认领，整批硬失败且不写进度。
    reset(); await run(); await run();
    assert.deepEqual([...new Set(tokens)].sort((a, b) => a - b), [6144, 8192], `实际预算：${[...new Set(tokens)].join(',')}`);
  });

  await t.test('缓存键全部落在自己的命名空间，不与第一个 skill 共用', async () => {
    reset(); await run(); await run();
    const keys = [...db.keys()];
    assert(keys.length > 0);
    assert(keys.every(k => k.startsWith(`${PREFIX}:`)), `越界键：${keys.filter(k => !k.startsWith(`${PREFIX}:`)).join(',')}`);
    assert(!keys.some(k => k.includes('first-principles')), '两个 skill 的缓存不得互相污染');
    assert.equal(lockKeys().length, 0, '锁必须释放');
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
    assert.equal(lockKeys().length, 0, '锁必须释放');
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

  await t.test('拒答在读流期间才到达（流内错误形态）时同样收敛到单块', async () => {
    reset();
    refuseMark = '【触发拒答的段落】'; refuseMode = 'stream';
    diaries = Array.from({ length: 4 }, (_, i) => make(`s${i}`, `第 ${i} 篇：宁可慢一点，也不把判断交给别人。`));
    diaries[3].summary += refuseMark;
    const corpus = makeValuesCorpus(structuredClone(diaries));
    const guilty = corpus.chunks.find(c => c.text.includes(refuseMark));
    assert(guilty);
    assert.equal((await run()).status, 202);
    assert.equal(skipKeys().length, 1, `流内拒答同样只该标记 1 块，实际 ${skipKeys().length} 块`);
    assert(skipKeys()[0].endsWith(`:skip:${guilty.key}`));
    assert(modelCalls >= 2 && modelCalls <= 9, `探测次数必须有界，实际 ${modelCalls}`);
    let report = null;
    for (let round = 0; round < 4 && !report; round++) { const r = await run(); if (r.status === 200) report = await r.text(); }
    assert.ok(report, '跳过被拒切块后必须能走到报告');
    assert.match(report, /另有 1 篇的部分正文被模型供应商的内容策略拒绝处理/);
  });

  await t.test('二分探测遇到非拒答失败：不标记任何切块，按原样抛出', async () => {
    reset();
    refuseMark = '【触发拒答的段落】'; networkFailAt = 2; // 第 2 次调用（第一次探测）模拟网络失败
    diaries = Array.from({ length: 12 }, (_, i) => make(`k${String(i).padStart(2, '0')}`, `第 ${i} 篇：宁可慢一点，也不把判断交给别人。`));
    diaries[11].summary += refuseMark;
    await assert.rejects(run(), /network down/);
    assert.equal(skipKeys().length, 0, '网络失败绝不能被当成拒答去写排除标记');
    assert.equal(writes.length, 0);
    assert.equal(lockKeys().length, 0, '锁必须释放');
  });

  await t.test('两半单独都能过时不猜：不写排除标记，原始拒答照常抛出', async () => {
    reset();
    batchOnlyRefusal = true; // 只有整批 12 块被拒，任何子批次都能过 —— 归因不到具体切块
    diaries = Array.from({ length: 12 }, (_, i) => make(`k${String(i).padStart(2, '0')}`, `第 ${i} 篇：宁可慢一点，也不把判断交给别人。`));
    await assert.rejects(run(), /Content Exists Risk/);
    assert.equal(skipKeys().length, 0, '归因不出来就不猜，宁可不写排除声明');
    assert(modelCalls <= 9, `探测次数必须有界，实际 ${modelCalls}`);
  });

  await t.test('标记写入失败不吞掉拒答：请求失败、锁释放，不留半截状态', async () => {
    reset();
    refuseMark = '【触发拒答的段落】'; pipelineBroken = true;
    diaries = [make('solo', `唯一一篇：宁可慢一点，也不把判断交给别人。${refuseMark}`)];
    await assert.rejects(run(), /redis pipeline failed/);
    assert.equal(skipKeys().length, 0);
    assert.equal(writes.length, 0);
    assert.equal(lockKeys().length, 0, '锁必须释放');
    // Redis 恢复后同上请求能正常写下标记
    pipelineBroken = false;
    assert.equal((await run()).status, 202);
    assert.equal(skipKeys().length, 1);
  });

  await t.test('多层综合：中间层必须校验并落盘，否则同一组被反复重算', async () => {
    // 2 篇文章只有一组、一步到最终层，覆盖不到中间层。60 篇逼出多个综合组：
    // 中间层若写入 null（或不做校验），读回来仍是 null，同一组会无限重算——
    // 每轮都是一次真实模型调用，进度却永远不动。
    reset();
    diaries = Array.from({ length: 60 }, (_, i) => make(`m${String(i).padStart(2, '0')}`, `第 ${i} 篇：宁可慢一点，也不把判断交给别人。`));
    let rounds = 0, report = null;
    while (rounds++ < 80) { const r = await run(); if (r.status === 200) { report = await r.text(); break; } }
    assert.ok(report, '必须在有限次内产出报告，不能停在中间层');
    assert(report.includes('60 篇公开文章'));
    const groupKeys = [...db.keys()].filter(k => k.includes(':group:'));
    assert(groupKeys.length > 0, `必须出现中间层 group 键，实际 ${groupKeys.length} 个`);
    assert(rounds > 3, '应当经过提炼与多个综合层');
    assert(![...db.entries()].some(([k, v]) => k.includes(':group:') && v == null), '中间层的值不能是 null');
  });

  await t.test('同长度改文只更新改动正文并使旧报告失效', async () => {
    reset(); await run(); await run();
    diaries[0].summary = diaries[0].summary.replace('判断', '现实');
    assert.equal((await run()).status, 202);
    assert.equal((await run()).status, 200);
    assert.equal(modelCalls, 4, '改文后必须重算受影响的切块与上层');
  });
});
