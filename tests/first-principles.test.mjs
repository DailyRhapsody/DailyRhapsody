import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('@/') ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier, context);
}});
after(() => hooks.deregister());
const { makeCorpus, planAnalysis, validateExtraction, validateNote, validateSynthesis, renderAnalysis, parseJson, isProviderRefusal } = await import('../lib/persona/first-principles.ts');
const diary = (id, summary = `文章${id}：判断应由证据支持。`) => ({id, date:'2026-10-08', summary, isPublic:true, bodyStatus:'complete'});
const finding = (chunk) => ({kind:'premise',claim:'判断依赖可核验的证据。',evidence:[{chunk:chunk.key,quote:chunk.text.slice(-100)}],boundary:'文本归纳，不代表普遍规律。'});
const store = () => { const data=new Map(); return {data,read: async keys => keys.map(k=>data.get(k)??null)}; };

test('全量按公开性筛选；同长度编辑、日期及撤回改变manifest，顺序不影响',()=>{
 const a=diary('a'), b=diary('b');
 const c=makeCorpus([b,a,{...diary('private'),isPublic:false,bodyStatus:'stale'}]);
 assert.equal(c.articles.length,2);
 assert.equal(c.hash,makeCorpus([a,b]).hash);
 assert.notEqual(c.hash,makeCorpus([{...a,summary:a.summary.replace('证据','权威')},b]).hash);
 assert.notEqual(c.hash,makeCorpus([{...a,date:'2020-01-01'},b]).hash);
 assert.notEqual(c.hash,makeCorpus([{...a,isPublic:false},b]).hash);
 assert.throws(()=>makeCorpus([{...a,bodyStatus:undefined}]));
});
test('长文完整分段，包含尾部反例并保留Unicode；媒体空文被明确计数',()=>{
 const text='证据🙂'.repeat(9000)+'尾部反例：仍须检查语境。';
 const c=makeCorpus([diary('long',text),diary('image','![](/api/media/x)')]);
 assert.equal(c.chunks.map(x=>x.text).join(''),text);
 assert(c.chunks.at(-1).text.includes('尾部反例'));
 assert.equal(c.empty,1);
});
test('每段必须返回且引用逐字存在；遗漏、重复、虚构引文均拒绝',()=>{
 const c=makeCorpus([diary('a'),diary('b')]);
 const rows=c.chunks.map(x=>({key:x.key,findings:[finding(x)]}));
 assert.equal(validateExtraction(rows,c.chunks).size,2);
 assert.throws(()=>validateExtraction(rows.slice(0,1),c.chunks));
 assert.throws(()=>validateExtraction([rows[0],rows[0]],c.chunks));
 assert.throws(()=>validateNote({findings:[{...finding(c.chunks[0]),evidence:[{chunk:c.chunks[0].key,quote:'不存在的引文'}]}]},c.chunks));
});
test('259篇全量分批至完成，综合包含真实日期和文章归属，缓存命中无需再调用模型',async()=>{
 const c=makeCorpus(Array.from({length:259},(_,i)=>diary(`id-${i}`)));
 const s=store(), seen=new Set(); let calls=0,result;
 for(let guard=0;guard<200;guard++){
  const p=await planAnalysis(c,s.read);
  if(p.result){result=p;break;}
  const w=p.work; calls++;
  assert(w.input.length<=18000,'input budget');
  if(w.phase==='extract'){
   const rows=w.chunks.map(x=>{seen.add(x.key);return {key:x.key,findings:[finding(x)]};});
   for(const [key,note] of validateExtraction(rows,w.chunks))s.data.set(`chunk:${key}`,note);
  }else{
   const input=JSON.parse(w.input);
   assert(input.sources.every(x=>x.articleId&&x.date&&x.title));
   const candidates=input.notes.flatMap(n=>n.findings);
   const note={findings:candidates.length?[candidates[0],candidates.at(-1)]:[]};
   s.data.set(w.key,validateSynthesis(note,w,c));
  }
 }
 assert.equal(seen.size,c.chunks.length);
 assert.equal(result?.completed,259);
 assert((await planAnalysis(c,s.read)).result);
 assert(calls>20&&calls<80);
 const changed=makeCorpus(c.articles.map((d,i)=>i===0?{...d,summary:'新增观点：选择需要保留退出权。'}:d));
 const p=await planAnalysis(changed,s.read);
 assert.equal(p.work.phase,'extract'); assert.equal(p.work.chunks.length,1);
});
test('综合只能继承本批已验证证据；报告链接由服务器生成',async()=>{
 const c=makeCorpus([diary('a'),diary('b')]); const s=store();
 for(const chunk of c.chunks)s.data.set(`chunk:${chunk.key}`,{findings:[finding(chunk)]});
 const p=await planAnalysis(c,s.read), w=p.work;
 const invented={...finding(c.chunks[0]),evidence:[{chunk:c.chunks[0].key,quote:c.chunks[0].text.slice(0,3)}]};
 assert.throws(()=>validateSynthesis({findings:[invented]},w,c));
 const report=renderAnalysis(c,{findings:[{...finding(c.chunks[0]),claim:'[危险](https://example.com)'}]});
 assert(report.includes('2 篇公开文章')); assert(report.includes('/blog#entry-a'));
 assert(report.includes('\\[危险\\]')); assert(!report.includes('href='));
});

test('长分析历史不会使后续普通聊天越过UTF-8请求上限',async()=>{
 const {chatRequestBody}=await import('../lib/persona/chat-request.ts');
 const history=Array.from({length:8},(_,i)=>[{role:'user',content:`分析${i}`},{role:'assistant',content:'中文🙂'.repeat(5000)}]).flat();
 history.push({role:'user',content:'继续讨论证据。'});
 const body=chatRequestBody(history),parsed=JSON.parse(body);
 assert(new TextEncoder().encode(body).length<=60*1024);
 assert.equal(parsed.messages[0].role,'user');
 assert.equal(parsed.messages.at(-1).content,'继续讨论证据。');
 assert(parsed.messages.filter(m=>m.role==='assistant').every(m=>m.content.length<=4000));
});

test('中间归纳在最大字段长度下仍然收敛，超出条数被截断而不是整组重算',async()=>{
 const c=makeCorpus(Array.from({length:100},(_,i)=>diary(`article-${i}`,`文章${i}：`+'据'.repeat(200))));
 const s=store();
 for(const chunk of c.chunks)s.data.set(`chunk:${chunk.key}`,{findings:[{...finding(chunk),claim:'论'.repeat(220),boundary:'界'.repeat(220),evidence:[{chunk:chunk.key,quote:'据'.repeat(180)}]}]});
 let calls=0,done=false;
 for(let guard=0;guard<80;guard++){
  const p=await planAnalysis(c,s.read);
  if(p.result){done=true;break;}
  const w=p.work,input=JSON.parse(w.input),evidence=input.notes.flatMap(n=>n.findings.flatMap(f=>f.evidence));
  const max=w.final?6:3;
  const findings=Array.from({length:max},(_,i)=>({kind:'premise',claim:'论'.repeat(220),boundary:'界'.repeat(220),evidence:evidence.slice(i*3,i*3+3).length?evidence.slice(i*3,i*3+3):evidence.slice(0,3)}));
  if(!w.final){
   // 模型多写一条时截断而不是硬失败：硬失败会让同一组被无限重算（见 validateSynthesis 注释）。
   // 综合的硬约束仍在：证据必须来自本批已核验输入、中间层必须压缩到可合并大小。
   const trimmed=validateSynthesis({findings:[...findings,findings[0]]},w,c);
   assert.equal(trimmed.findings.length,max,'超出的条目必须被截断，而不是让整组反复重算');
  }
  s.data.set(w.key,validateSynthesis({findings},w,c));calls++;
 }
 assert(done,'bounded reduction must converge'); assert(calls<40,`unexpected calls: ${calls}`);
});

test('模型返回 JSONL（每行一个对象）时也能解析，真模型实测会这样', () => {
  const a = { key: 'k1', findings: [] };
  const b = { key: 'k2', findings: [{ kind: 'premise', claim: 'x', evidence: [{ chunk: 'k2', quote: 'q' }], boundary: 'b' }] };
  assert.deepEqual(parseJson(`${JSON.stringify(a)}\n${JSON.stringify(b)}`), [a, b]);
  // 带代码围栏的 JSONL 同样接受
  assert.deepEqual(parseJson('```json\n' + JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n```'), [a, b]);
  // 正常的单个数组不受影响
  assert.deepEqual(parseJson(JSON.stringify([a, b])), [a, b]);
  // 单行但非法：原样抛出，不吞错
  assert.throws(() => parseJson('{oops'));
  // 多行里有非法行：抛出，不静默丢弃
  assert.throws(() => parseJson(`${JSON.stringify(a)}\n{oops`));
});

const fpDiary = (id, text) => ({ id, date: '2026-10-08', summary: text, isPublic: true, bodyStatus: 'complete' });

test('提炼阶段逐条丢弃：一条假引文不再作废整批已验证内容', () => {
  const corpus = makeCorpus([fpDiary('a', '判断必须回到原文。'), diary('b', '证据来自文本本身。')]);
  const [c0, c1] = corpus.chunks;
  const good = { key: c0.key, findings: [{ kind: 'premise', claim: '结论', evidence: [{ chunk: c0.key, quote: c0.text.slice(0, 6) }], boundary: '边界' }] };
  const badQuote = { key: c1.key, findings: [{ kind: 'premise', claim: '结论', evidence: [{ chunk: c1.key, quote: '这段原文里根本没有' }], boundary: '边界' }] };
  const out = validateExtraction([good, badQuote], corpus.chunks);
  assert.equal(out.get(c0.key).findings.length, 1, '合格的那条必须留下');
  assert.equal(out.get(c1.key).findings.length, 0, '引文不实的那条应被丢掉');

  // 综合阶段仍然严格：同样的输入在 validateNote 默认模式下必须抛错
  assert.throws(() => validateNote(badQuote, [c1], 2), /引文无法回溯原文/);
});

test('提炼阶段丢条目但不放过批次结构错误', () => {
  const corpus = makeCorpus([fpDiary('a', '判断必须回到原文。')]);
  // 段数不符仍然整批拒绝，逐条放宽不能把结构性错误也吞掉
  assert.throws(() => validateExtraction([], corpus.chunks), /没有覆盖全部正文分段/);
  assert.throws(() => validateExtraction([{ key: '不属于本批', findings: [] }], corpus.chunks), /不属于本次材料/);
});

test('能认出供应商的内容策略拒答，其余错误不当作拒答', () => {
  assert.equal(isProviderRefusal(new Error('Content Exists Risk (request_id: abc)')), true);
  assert.equal(isProviderRefusal(new Error('data_inspection_failed')), true);
  assert.equal(isProviderRefusal(new Error('HTTP 502')), false);
  assert.equal(isProviderRefusal(new Error('分析输出过长')), false);
  assert.equal(isProviderRefusal('not an error'), false);
});

test('报告声明被供应商拒绝的段落，覆盖范围不含糊', () => {
  const corpus = makeCorpus([fpDiary('a', '判断必须回到原文。')]);
  const withExclusions = renderAnalysis(corpus, { findings: [] }, { chunks: 12, articles: 4 });
  assert.match(withExclusions, /4 篇的部分正文被模型供应商的内容策略拒绝处理/);
  const plain = renderAnalysis(corpus, { findings: [] });
  assert.doesNotMatch(plain, /内容策略拒绝/, '没有排除时不该出现这句');
});

test('流式拒答（finish_reason=content_filter / sensitive）可识别，真实截断仍然算失败', async (t) => {
  const { streamChat } = await import('../lib/persona/llm.ts');
  // 只为让 getConfig() 通过：fetch 全程被 mock，绝不发真实请求
  const env = { PERSONA_LLM_API_KEY: 'test-key', PERSONA_LLM_MODEL: 'test-model', PERSONA_LLM_PROTOCOL: undefined, PERSONA_LLM_BASE_URL: undefined };
  const previous = {};
  for (const [k, v] of Object.entries(env)) { previous[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  let body = '', status = 200;
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
  const line = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
  const delta = (text, finish = null) => line({ choices: [{ delta: text === undefined ? {} : { content: text }, finish_reason: finish }] });
  const drain = async (stream) => { const reader = stream.getReader(); let out = ''; for (;;) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); } return out; };
  const call = (strict) => streamChat({ system: 's', messages: [{ role: 'user', content: '正文' }], maxTokens: 64, strict });

  // 最常见形态：没有 error 行，只有 finish_reason=content_filter
  body = delta('一段正文', null) + delta(undefined, 'content_filter') + line('[DONE]');
  await assert.rejects(drain(await call(true)), (e) => {
    assert.equal(isProviderRefusal(e), true, `content_filter 拒答必须可识别，实际消息：${e.message}`);
    assert.match(e.message, /content_filter/);
    return true;
  });

  // 同族：部分供应商用 sensitive
  body = delta(undefined, 'sensitive') + line('[DONE]');
  await assert.rejects(drain(await call(true)), (e) => {
    assert.equal(isProviderRefusal(e), true, `sensitive 拒答必须可识别，实际消息：${e.message}`);
    return true;
  });

  // 反向：真实截断（finish_reason=length）是另一回事，strict 下继续失败，且绝不能被认成拒答
  body = delta('半句话', null) + delta(undefined, 'length') + line('[DONE]');
  await assert.rejects(drain(await call(true)), (e) => {
    assert.equal(isProviderRefusal(e), false, '截断被当成拒答就会静默排除切块');
    assert.match(e.message, /未完整返回/);
    return true;
  });
  // 非 strict（普通聊天）下截断照旧补一句收尾，不报错
  body = delta('半句话', null) + delta(undefined, 'length') + line('[DONE]');
  assert.match(await drain(await call(false)), /篇幅有限/);

  // 普通的 SSE 内错误行不受影响
  body = delta('正文', null) + line({ error: { message: 'upstream boom' } }) + line('[DONE]');
  await assert.rejects(drain(await call(true)), (e) => {
    assert.equal(isProviderRefusal(e), false);
    assert.match(e.message, /upstream boom/);
    return true;
  });

  // Azure 风格：message 干净、只有 code=content_filter；连接期 HTTP 错误体
  status = 400;
  body = JSON.stringify({ error: { code: 'content_filter', message: 'The response was filtered' } });
  await assert.rejects(call(true), (e) => {
    assert.equal(isProviderRefusal(e), true, `error.code 必须带进错误消息，实际：${e.message}`);
    assert.match(e.message, /content_filter/);
    return true;
  });
  // 只有 code、没有 message，也必须留下关键词
  body = JSON.stringify({ error: { code: 'content_filter' } });
  await assert.rejects(call(true), (e) => { assert.equal(isProviderRefusal(e), true, `实际：${e.message}`); return true; });
  // 良性错误：不误判成拒答，但 code/type 仍要记进消息，线上才看得到原因
  body = JSON.stringify({ error: { code: 'invalid_request_error', type: 'invalid_request', message: 'bad model' } });
  await assert.rejects(call(true), (e) => {
    assert.equal(isProviderRefusal(e), false);
    assert.match(e.message, /invalid_request_error/);
    assert.match(e.message, /bad model/);
    return true;
  });
  // 200 + SSE 内错误体（有的供应商这样返回拒答）同样要带上 code
  status = 200;
  body = line({ error: { code: 'content_filter', message: 'blocked' } });
  await assert.rejects(drain(await call(true)), (e) => {
    assert.equal(isProviderRefusal(e), true, `实际：${e.message}`);
    assert.match(e.message, /content_filter/);
    return true;
  });
});

test('切块从被跳过变为有内容后，上层报告键必须改变；内容不变时键保持稳定', async () => {
  const corpus = makeCorpus([fpDiary('a', '判断必须回到原文。'), fpDiary('b', '证据来自文本本身。')]);
  const [c0, c1] = corpus.chunks;
  const s = store();
  s.data.set(`chunk:${c1.key}`, { findings: [finding(c1)] });
  s.data.set(`skip:${c0.key}`, { reason: 'provider-refusal' }); // c0 被拒：空 note
  const skipped = await planAnalysis(corpus, s.read);
  assert.equal(skipped.work.phase, 'synthesize');
  assert.deepEqual(skipped.exclusions, { chunks: 1, articles: 1 });
  // 缓存里现在躺着一份「用空 note 算出的旧报告」：修复前它会被原样复用（引用 c0 原文却声明 c0 未纳入）
  s.data.set(skipped.work.key, { findings: [finding(c1)] });

  // skip 标记先消失（7 天 TTL / Redis 淘汰），切块被重新提炼并落盘，而切块 key 不变
  s.data.delete(`skip:${c0.key}`);
  s.data.set(`chunk:${c0.key}`, { findings: [finding(c0)] });
  const refined = await planAnalysis(corpus, s.read);
  assert.equal(refined.result, undefined, '旧报告不能被当成结果直接返回');
  assert(refined.work, '切块内容已变，必须重算而不是复用用空 note 算出的旧报告');
  assert.equal(refined.work.phase, 'synthesize');
  assert.deepEqual(refined.exclusions, { chunks: 0, articles: 0 });
  assert.notEqual(refined.work.key, skipped.work.key,
    '子节点内容变了 key 却不变，旧报告会被原样复用：一边引用原文一边声明该段未纳入');
  // 同一份内容再规划：键必须稳定，否则永远命不中缓存
  const again = await planAnalysis(corpus, s.read);
  assert.equal(again.work.key, refined.work.key);
});

test('中间层 group 键同样按子节点内容派生，未受影响的组继续命中缓存', async () => {
  // 30 个满长度切块：pack 会分成多个 group，覆盖中间层（几十篇塞进一组就覆盖不到）
  const articles = Array.from({ length: 30 }, (_, i) => fpDiary(`g${String(i).padStart(3, '0')}`, `第 ${i} 篇：` + '据'.repeat(400)));
  const corpus = makeCorpus(articles);
  assert.equal(corpus.chunks.length, 30);
  const s = store();
  const big = (chunk) => ({ findings: [{ kind: 'premise', claim: '论'.repeat(220), evidence: [{ chunk: chunk.key, quote: '据'.repeat(180) }], boundary: '界'.repeat(220) }] });
  for (const chunk of corpus.chunks.slice(0, -1)) s.data.set(`chunk:${chunk.key}`, big(chunk));
  const last = corpus.chunks.at(-1);
  s.data.set(`skip:${last.key}`, { reason: 'provider-refusal' });

  const first = await planAnalysis(corpus, s.read);
  assert.equal(first.work.final, false, '这个规模必须出现中间层，否则测不到 group 键');
  const group1 = first.work.key;
  s.data.set(group1, { findings: [] }); // 第一组命中缓存后，两次规划都只返回含被跳过切块的那一组
  const before = await planAnalysis(corpus, s.read);
  assert.notEqual(before.work.key, group1);
  const affected = before.work.key;

  s.data.delete(`skip:${last.key}`);
  s.data.set(`chunk:${last.key}`, big(last));
  const after = await planAnalysis(corpus, s.read);
  assert.notEqual(after.work.key, group1, '未受影响的组必须继续命中缓存（分组没有漂移）');
  assert.notEqual(after.work.key, affected, '子节点从空 note 变成真实 note，这一组的键必须改变');
});

test('读缓存长度与请求不符时直接报错，不把 skip 标记错配到别的切块', async () => {
  const corpus = makeCorpus([fpDiary('a', '判断必须回到原文。'), fpDiary('b', '证据来自文本本身。')]);
  await assert.rejects(planAnalysis(corpus, async (keys) => keys.slice(0, -1).map(() => null)), /分析缓存读取不完整/);
  await assert.rejects(planAnalysis(corpus, async (keys) => [...keys, null].map(() => null)), /分析缓存读取不完整/);
});
