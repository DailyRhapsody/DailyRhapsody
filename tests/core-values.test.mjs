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

test('提示词把分类判据写成可执行的排除式，不只是关键词存在', () => {
  const c = makeValuesCorpus([diary('a')]);
  const extract = valuesPrompt({ key: 'batch:x', phase: 'extract', chunks: c.chunks, input: JSON.stringify(c.chunks), final: false });
  const final = valuesPrompt({ key: 'report:x', phase: 'synthesize', input: '{"notes":[]}', final: true });
  // 「据说」一类归属词必须与否定同句，否则等于没排除
  assert.match(extract, /归属词的是转述，同样不算/);
  // 情态词与摘抄各有归属规则：这两条是真实语料里误判最多的来源
  assert.match(extract, /「应该」「应当」「必须」只有在作者以第一人称认领/);
  assert.match(extract, /整段是典籍、译文、格言或他人文章的摘抄时不算/);
  // 取舍的主语约束与「约束」区分
  assert.match(extract, /主语必须是作者本人/);
  assert.match(extract, /记为约束，不算取舍/);
  // 五类各自的判据句都在（各取一句可核的措辞）
  assert.match(extract, /tradeoff 取舍与代价：[\s\S]*被让渡的那一项/);
  assert.match(extract, /judgment 褒贬与底线：[\s\S]*可复述的做法/);
  assert.match(extract, /conflict 张力与落差：[\s\S]*落差的方向/);
  assert.match(extract, /shift 价值变化：[\s\S]*让位给另一种/);
  assert.match(final, /每类至少保留一条/);
});

test('提示词里的维度枚举、条数上限与校验层同源，任一漂移都会红', () => {
  const c = makeValuesCorpus([diary('a')]);
  const chunk = c.chunks[0];
  const make9 = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'value', claim: `结论${i}`, evidence: [{ chunk: chunk.key, quote: chunk.text.slice(0, 6) }], boundary: '边界' }));
  const final = valuesPrompt({ key: 'report:x', phase: 'synthesize', input: '{"notes":[]}', final: true });

  // 枚举：提示词声明的 kind 集合必须与校验层白名单一致（加类或改名都会在这里红）
  const declared = final.match(/"kind":"([^"]+)"/)[1].split('|');
  for (const kind of declared) {
    assert.equal(validateValuesNote({ findings: [{ ...make9(1)[0], kind }] }, [chunk]).findings[0].kind, kind);
  }
  assert.throws(() => validateValuesNote({ findings: [{ ...make9(1)[0], kind: 'premise' }] }, [chunk]), /缺少原文证据/);

  // 条数：提示词写的上限必须等于校验层的实际截断条数（两边任一侧改动都会红）
  const cap = Number(final.match(/最多(\d+)条/)[1]);
  assert.equal(validateValuesNote({ findings: make9(cap + 3) }, c.chunks, cap, { dropUnverified: true }).findings.length, cap);
  // 默认上限（最终报告那一档）也必须等于提示词写的数
  assert.equal(validateValuesNote({ findings: make9(cap + 3) }, c.chunks, undefined, { dropUnverified: true }).findings.length, cap);
  // 严格模式仍然硬失败：超上限只允许在可丢弃层被截断
  assert.throws(() => validateValuesNote({ findings: make9(cap + 1) }, c.chunks), /超过上限/);
});

test('claim 与 boundary 里的网址一律剥离，引文保持逐字', () => {
  const c = makeValuesCorpus([diary('a')]);
  const chunk = c.chunks[0];
  const note = validateValuesNote({ findings: [{ kind: 'tradeoff',
    claim: '去看 https://evil.example/x?d=1 的说法', evidence: [{ chunk: chunk.key, quote: chunk.text.slice(0, 6) }],
    boundary: '见 [说明](https://evil.example/y) 一节' }] }, [chunk]);
  assert.equal(note.findings.length, 1);
  assert(!note.findings[0].claim.includes('evil.example'), `claim 仍带网址：${note.findings[0].claim}`);
  assert(!note.findings[0].boundary.includes('evil.example'), `boundary 仍带网址：${note.findings[0].boundary}`);
  assert(note.findings[0].boundary.includes('说明'), 'Markdown 链接只去掉目标，保留文字');
  // 报告里因此不会出现模型给的链接
  assert(!renderValues(c, note).includes('evil.example'));
  // 整条只有网址等于没有内容
  assert.throws(() => validateValuesNote({ findings: [{ kind: 'value', claim: 'https://evil.example/x',
    evidence: [{ chunk: chunk.key, quote: chunk.text.slice(0, 6) }], boundary: '边界' }] }, [chunk]), /分析字段无效/);
  // 引文必须逐字，原文里的网址不能被剥掉
  const c2 = makeValuesCorpus([diary('b', '参考 https://example.com/a 的说法。')]);
  const note2 = validateValuesNote({ findings: [{ kind: 'value', claim: '结论',
    evidence: [{ chunk: c2.chunks[0].key, quote: 'https://example.com/a' }], boundary: '边界' }] }, c2.chunks);
  assert(note2.findings[0].evidence[0].quote.includes('https://example.com/a'));
});

test('报告章节顺序与维度枚举同源，五类都有候选时顺序恒定', () => {
  const c = makeValuesCorpus([diary('a')]);
  const chunk = c.chunks[0];
  const findings = ['tradeoff', 'value', 'judgment', 'conflict', 'shift'].map((kind) => ({ kind,
    claim: `${kind} 结论`, evidence: [{ chunk: chunk.key, quote: chunk.text.slice(0, 6) }], boundary: '边界' }));
  const report = renderValues(c, { findings });
  assert.deepEqual([...report.matchAll(/^### (.+)$/gm)].map((m) => m[1]),
    ['价值排序（取舍与代价）', '价值主张', '褒贬与底线', '张力与落差', '价值变化']);
});

test('读缓存长度与请求不符时直接报错，不把 skip 标记错配到别的切块', async () => {
  const c = makeValuesCorpus([diary('a'), diary('b')]);
  await assert.rejects(planValues(c, async (keys) => keys.slice(0, -1).map(() => null)), /分析缓存读取不完整/);
  await assert.rejects(planValues(c, async (keys) => [...keys, null].map(() => null)), /分析缓存读取不完整/);
});

test('中间归纳在最大字段长度下仍然收敛，超出条数被截断而不是整组重算', async () => {
  const c = makeValuesCorpus(Array.from({ length: 100 }, (_, i) => diary(`article-${i}`, `文章${i}：` + '据'.repeat(200))));
  const s = store();
  for (const chunk of c.chunks) s.data.set(`chunk:${chunk.key}`, { findings: [{ kind: 'value', claim: '论'.repeat(220),
    boundary: '界'.repeat(220), evidence: [{ chunk: chunk.key, quote: '据'.repeat(180) }] }] });
  let calls = 0, done = false;
  for (let guard = 0; guard < 80; guard++) {
    const p = await planValues(c, s.read);
    if (p.result) { done = true; break; }
    const w = p.work, input = JSON.parse(w.input), evidence = input.notes.flatMap(n => n.findings.flatMap(f => f.evidence));
    const max = w.final ? 8 : 3;
    const findings = Array.from({ length: max }, (_, i) => ({ kind: 'value', claim: '论'.repeat(220), boundary: '界'.repeat(220),
      evidence: evidence.slice(i * 3, i * 3 + 3).length ? evidence.slice(i * 3, i * 3 + 3) : evidence.slice(0, 3) }));
    if (!w.final) {
      // 模型多写一条时截断而不是硬失败：硬失败会让同一组被无限重算
      const trimmed = validateValuesSynthesis({ findings: [...findings, findings[0]] }, w, c);
      assert.equal(trimmed.findings.length, max, '超出的条目必须被截断，而不是让整组反复重算');
    }
    s.data.set(w.key, validateValuesSynthesis({ findings }, w, c));
    calls++;
  }
  assert(done, 'bounded reduction must converge');
  assert(calls < 40, `unexpected calls: ${calls}`);
});
