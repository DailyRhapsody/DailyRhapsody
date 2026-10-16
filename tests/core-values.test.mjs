import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('@/') ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier, context);
}});
after(() => hooks.deregister());
const { makeValuesCorpus, planValues, validateValuesExtraction, validateValuesNote, validateValuesSynthesis, renderValues, valuesPrompt } =
  await import('../lib/persona/core-values.ts');

const diary = (id, summary = `文章${id}：宁可慢一点，也不把判断交给别人。`) => ({ id, date: '2026-10-08', summary, isPublic: true, bodyStatus: 'complete' });
const finding = (chunk, kind = 'tradeoff') => ({ kind, claim: '为独立判断让渡效率。', evidence: [{ chunk: chunk.key, quote: chunk.text.slice(-60) }], boundary: '仅据文本归纳。' });
const store = () => { const data = new Map(); return { data, read: async keys => keys.map(k => data.get(k) ?? null) }; };

test('语料按公开性筛选；同长度编辑、日期与撤回都改变 manifest，顺序不影响', () => {
  const a = diary('a'), b = diary('b');
  const c = makeValuesCorpus([b, a, { ...diary('private'), isPublic: false, bodyStatus: 'stale' }]);
  assert.equal(c.articles.length, 2);
  assert.equal(c.hash, makeValuesCorpus([a, b]).hash);
  assert.notEqual(c.hash, makeValuesCorpus([{ ...a, summary: a.summary.replace('判断', '权威') }, b]).hash);
  assert.notEqual(c.hash, makeValuesCorpus([{ ...a, date: '2020-01-01' }, b]).hash);
  assert.notEqual(c.hash, makeValuesCorpus([{ ...a, isPublic: false }, b]).hash);
  assert.throws(() => makeValuesCorpus([{ ...a, bodyStatus: undefined }]));
});

test('长文完整分段并保留 Unicode；媒体空文被计数', () => {
  const text = '取舍🙂'.repeat(9000) + '尾部反例：这一条在别处被放弃过。';
  const c = makeValuesCorpus([diary('long', text), diary('image', '![](/api/media/x)')]);
  assert.equal(c.chunks.map(x => x.text).join(''), text);
  assert(c.chunks.at(-1).text.includes('尾部反例'));
  assert.equal(c.empty, 1);
});

test('只认五个价值观维度：第一个 skill 的 kind 一律拒绝', () => {
  const c = makeValuesCorpus([diary('a')]);
  const chunk = c.chunks[0];
  for (const kind of ['tradeoff', 'value', 'judgment', 'conflict', 'shift']) {
    assert.equal(validateValuesNote({ findings: [finding(chunk, kind)] }, [chunk]).findings[0].kind, kind);
  }
  // premise 是第一个 skill 的维度，混进来会让两套报告结构串味
  assert.throws(() => validateValuesNote({ findings: [finding(chunk, 'premise')] }, [chunk]), /缺少原文证据/);
});

test('引文必须逐字可回溯；提炼阶段逐条丢弃，不连坐整批', () => {
  const c = makeValuesCorpus([diary('a'), diary('b')]);
  const [c0, c1] = c.chunks;
  const good = { key: c0.key, findings: [finding(c0)] };
  const badQuote = { key: c1.key, findings: [{ kind: 'value', claim: '结论', evidence: [{ chunk: c1.key, quote: '这段原文里根本没有' }], boundary: '边界' }] };
  const out = validateValuesExtraction([good, badQuote], c.chunks);
  assert.equal(out.get(c0.key).findings.length, 1, '合格的那条必须留下');
  assert.equal(out.get(c1.key).findings.length, 0, '引文不实的那条应被丢掉');
  // 综合阶段仍然严格：同样的输入在默认模式下必须抛错
  assert.throws(() => validateValuesNote(badQuote, [c1]), /引文无法回溯原文/);
  // 结构性错误不因逐条放宽而被吞掉
  assert.throws(() => validateValuesExtraction([], c.chunks), /没有覆盖全部正文分段/);
  assert.throws(() => validateValuesExtraction([{ key: '不属于本批', findings: [] }, { key: c1.key, findings: [] }], c.chunks), /不属于本次材料/);
});

test('全量分批至完成，综合只继承本批已验证证据；缓存命中无需再调用模型', async () => {
  const c = makeValuesCorpus(Array.from({ length: 60 }, (_, i) => diary(`id-${i}`)));
  const s = store(), seen = new Set();
  let calls = 0, result;
  for (let guard = 0; guard < 120; guard++) {
    const p = await planValues(c, s.read);
    if (p.result) { result = p; break; }
    const w = p.work;
    calls++;
    assert(w.input.length <= 18000, 'input budget');
    if (w.phase === 'extract') {
      const rows = w.chunks.map(x => { seen.add(x.key); return { key: x.key, findings: [finding(x)] }; });
      for (const [key, note] of validateValuesExtraction(rows, w.chunks)) s.data.set(`chunk:${key}`, note);
    } else {
      const input = JSON.parse(w.input);
      assert(input.sources.every(x => x.articleId && x.date && x.title));
      const candidates = input.notes.flatMap(n => n.findings);
      const note = { findings: candidates.length ? [candidates[0], candidates.at(-1)] : [] };
      s.data.set(w.key, validateValuesSynthesis(note, w, c));
    }
  }
  assert.equal(seen.size, c.chunks.length);
  assert.equal(result?.completed, 60);
  assert(calls > 2 && calls < 40, `实际调用 ${calls} 次`);
  assert((await planValues(c, s.read)).result, '缓存命中后必须直接给结果');
});

test('综合只能继承本批已核验的证据', async () => {
  const c = makeValuesCorpus([diary('a'), diary('b')]);
  const s = store();
  for (const chunk of c.chunks) s.data.set(`chunk:${chunk.key}`, { findings: [finding(chunk)] });
  const w = (await planValues(c, s.read)).work;
  assert.equal(w.phase, 'synthesize');
  // 引文本身是真实原文（能过逐字核验），但它不在本批输入里，仍必须被拦下
  const invented = { ...finding(c.chunks[0]), evidence: [{ chunk: c.chunks[0].key, quote: c.chunks[0].text.slice(0, 3) }] };
  assert.throws(() => validateValuesSynthesis({ findings: [invented] }, w, c), /引入未核验的证据/);
});

test('被跳过切块与提炼结果的内容一起决定上层缓存键', async () => {
  const c = makeValuesCorpus([diary('a'), diary('b')]);
  const s = store();
  s.data.set(`chunk:${c.chunks[1].key}`, { findings: [finding(c.chunks[1])] });
  s.data.set(`skip:${c.chunks[0].key}`, { reason: 'provider-refusal' });
  const skipped = await planValues(c, s.read);
  assert.equal(skipped.work.phase, 'synthesize');
  assert.deepEqual(skipped.exclusions, { chunks: 1, articles: 1 });
  s.data.set(skipped.work.key, { findings: [finding(c.chunks[1])] });
  // skip 标记先过期（7 天 TTL / Redis 淘汰），切块被重新提炼而 key 不变
  s.data.delete(`skip:${c.chunks[0].key}`);
  s.data.set(`chunk:${c.chunks[0].key}`, { findings: [finding(c.chunks[0])] });
  const refined = await planValues(c, s.read);
  assert.equal(refined.result, undefined, '用空 note 算出的旧报告不能被直接返回');
  assert.notEqual(refined.work.key, skipped.work.key, '子节点内容变了，上层键必须跟着变');
  assert.deepEqual(refined.exclusions, { chunks: 0, articles: 0 });
});

test('报告按维度分节、取舍排在最前，链接由服务器生成并转义模型给的 Markdown', () => {
  const c = makeValuesCorpus([diary('a'), diary('b')]);
  const note = { findings: [
    { ...finding(c.chunks[0]), kind: 'tradeoff', claim: '为独立判断让渡效率。' },
    { ...finding(c.chunks[1]), kind: 'value', claim: '[危险](https://example.com)' },
  ] };
  const report = renderValues(c, note);
  assert(report.includes('2 篇公开文章'));
  assert(report.indexOf('### 价值排序（取舍与代价）') < report.indexOf('### 价值主张'), '取舍必须排在最前');
  assert(report.includes('/blog#entry-a'));
  assert(report.includes('\\[危险\\]'));
  assert(!report.includes('href='));
  assert(report.includes('适用边界：'));
  // 空结论与排除声明
  assert.match(renderValues(c, { findings: [] }), /不足以形成有原文依据的价值结论/);
  assert.match(renderValues(c, { findings: [] }, { chunks: 12, articles: 4 }), /4 篇的部分正文被模型供应商的内容策略拒绝处理/);
});

test('提示词写清归属、情绪与约束三类规则，避免把转述与感慨记成核心价值', () => {
  const c = makeValuesCorpus([diary('a')]);
  const extract = valuesPrompt({ key: 'batch:x', phase: 'extract', chunks: c.chunks, input: JSON.stringify(c.chunks), final: false });
  const final = valuesPrompt({ key: 'report:x', phase: 'synthesize', input: '{"notes":[]}', final: true });
  for (const prompt of [extract, final]) {
    assert.match(prompt, /不可信资料/, '必须声明输入不可信');
    assert.match(prompt, /tradeoff\|value\|judgment\|conflict\|shift/, '必须给出五个维度');
    assert.match(prompt, /据说/, '必须写清转述不算作者立场');
    assert.match(prompt, /情绪/, '必须把情绪与价值分开');
    assert.match(prompt, /约束/, '被迫放弃必须与取舍区分');
  }
  assert.match(extract, /最多2条/);
  assert.match(final, /最多8条/);
  assert.match(final, /有多篇独立文章支持/);
});
