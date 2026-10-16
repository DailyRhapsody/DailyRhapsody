import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Socket } from 'node:net';
import { test } from 'node:test';

test('全量分析接口：分批、缓存、并发、撤回和失败恢复（仅离线）',async t=>{
 const hooks=registerHooks({resolve(s,c,n){return n(s==='next/server'?'next/server.js':s.startsWith('@/')?new URL(`../${s.slice(2)}.ts`,import.meta.url).href:s,c);}});
 const blocked=()=>{throw new Error('Real network forbidden');};
 const fetch=t.mock.method(globalThis,'fetch',blocked), connect=t.mock.method(Socket.prototype,'connect',blocked);
 const env={UPSTASH_REDIS_REST_URL:'https://redis.test.invalid',UPSTASH_REDIS_REST_TOKEN:'test-token',VERCEL_ENV:'test'};
 const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 t.after(()=>{hooks.deregister();for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}assert.equal(fetch.mock.callCount(),0);assert.equal(connect.mock.callCount(),0);});
 const db=new Map(),writes=[];let sourceCalls=0, modelCalls=0,authorizeCalls=0,changeDuringModel=false,broken=false,gate;
 // 拒答相关开关：refuseMark 是触发拒答的原文片段，refuseMode 决定它以哪种形态到达
 // （建立连接时抛出 vs 读流时以流内错误到达）；其余几个用来压收敛的边界。
 let refuseMark=null,refuseMode='throw',networkFailAt=0,batchOnlyRefusal=false,pipelineBroken=false;
 const make=(id,text=`证据${id}：判断必须回到原文。`)=>({id,date:'2026-10-08',summary:text,isPublic:true,bodyStatus:'complete'});
 let diaries=[make('a'),make('b')];
 t.mock.module(new URL('../lib/notion.ts',import.meta.url).href,{namedExports:{getAnalysisDiaries:async()=>{sourceCalls++;return diaries===null?null:structuredClone(diaries);}}});
 t.mock.module(new URL('../lib/request-guard.ts',import.meta.url).href,{namedExports:{withAntiScrapeHeaders:r=>r}});
 t.mock.module('@upstash/redis',{namedExports:{Redis:class{
  async mget(...keys){return keys.map(k=>structuredClone(db.get(k)??null));}
  async set(k,v,opts){if(opts?.nx&&db.has(k))return null;db.set(k,structuredClone(v));return 'OK';}
  pipeline(){const queued=[];return {set(k,v){queued.push([k,v]);return this;},async exec(){if(pipelineBroken)throw new Error('redis pipeline failed');for(const[k,v]of queued){db.set(k,structuredClone(v));writes.push(k);}return queued.map(()=> 'OK');}};}
  async eval(_,[key],[token]){return db.get(key)===token?Number(db.delete(key)):0;}
 }}});
 t.mock.module(new URL('../lib/persona/llm.ts',import.meta.url).href,{namedExports:{streamChat:async opts=>{
  modelCalls++;assert.equal(opts.strict,true);assert(opts.signal);if(gate)await gate.promise;
  if(networkFailAt&&modelCalls===networkFailAt)throw new Error('network down');
  const input=JSON.parse(opts.messages[0].content);
  // 只有含 refuseMark 的切块会触发拒答；batchOnlyRefusal 模拟「整批组合才被拒」的不可归因情形
  const refused=(refuseMark&&Array.isArray(input)&&input.some(c=>typeof c.text==='string'&&c.text.includes(refuseMark)))
   ||(batchOnlyRefusal&&Array.isArray(input)&&input.length>=12);
  if(refused){const e=new Error('Content Exists Risk (request_id: test)');if(refuseMode==='stream')return new ReadableStream({start(c){c.error(e);}});throw e;}
  const raw=Array.isArray(input)?input.map(c=>({key:c.key,findings:[{kind:'premise',claim:'判断须有证据。',evidence:[{chunk:c.key,quote:c.text.slice(-80)}],boundary:'仅据文本归纳。'}]})):{findings:input.notes.flatMap(n=>n.findings).slice(0,6)};
  if(changeDuringModel)diaries=diaries.filter(d=>d.id!=='a');
  return new ReadableStream({start(c){if(broken){c.error(new Error('interrupted'));return;}c.enqueue(new TextEncoder().encode(JSON.stringify(raw)));c.close();}});
 }}});
 const {runFirstPrinciples}=await import('../lib/persona/first-principles-route.ts');
 const {makeCorpus}=await import('../lib/persona/first-principles.ts');
 const request=()=>new Request('http://local.test/api/chat',{method:'POST',body:'{}'});
 const auth=async()=>{authorizeCalls++;return null;};
 const run=()=>runFirstPrinciples(request(),auth);
 const skipKeys=()=>[...db.keys()].filter(k=>k.includes(':skip:'));
 const reset=()=>{db.clear();writes.length=0;diaries=[make('a'),make('b')];modelCalls=0;authorizeCalls=0;changeDuringModel=false;broken=false;gate=undefined;refuseMark=null;refuseMode='throw';networkFailAt=0;batchOnlyRefusal=false;pipelineBroken=false;};
 await t.test('202提炼→最终报告→缓存命中；缓存不消耗模型额度',async()=>{
  reset();assert.equal((await run()).status,202);
  const report=await run();assert.equal(report.status,200);assert((await report.text()).includes('2 篇公开文章'));
  assert.equal(modelCalls,2);assert.equal(authorizeCalls,2);
  assert.equal((await run()).status,200);assert.equal(modelCalls,2);assert.equal(authorizeCalls,2);
  assert(sourceCalls>=6,'must re-read current sources before publication');
 });
 await t.test('失效/缺失快照不返回缓存报告',async()=>{diaries=null;const r=await run();assert.equal(r.status,202);assert.equal((await r.json()).phase,'sources');assert.equal(modelCalls,2);});
 await t.test('生成中撤回公开文章，禁止写入旧依据或报告',async()=>{reset();changeDuringModel=true;const r=await run();assert.equal(r.status,202);assert.equal((await r.json()).phase,'sources');assert.equal(writes.length,0);});
 await t.test('模型中断不提交，下一次从已完成进度继续',async()=>{reset();broken=true;await assert.rejects(run());assert.equal(writes.length,0);assert(![...db.keys()].some(k=>k.endsWith('build-lock')));broken=false;assert.equal((await run()).status,202);});
 await t.test('并发点击仅一个模型调用',async()=>{reset();gate=Promise.withResolvers();const one=run();while(!modelCalls)await new Promise(r=>setImmediate(r));const two=await run();assert.equal(two.status,202);assert.equal(modelCalls,1);gate.resolve();await one;assert.equal(modelCalls,1);});
 await t.test('额度拒绝不调用模型且释放锁',async()=>{reset();const r=await runFirstPrinciples(request(),async()=>new Response('quota',{status:429}));assert.equal(r.status,429);assert.equal(modelCalls,0);assert.equal(db.size,0);});
 await t.test('多层综合：中间层必须落盘，否则同一组被反复重算',async()=>{
  // 2 篇文章只有一组、一步到最终层，覆盖不到中间层。这里造 40 篇逼出多个综合组：
  // 曾经把 `work.final ? validateSynthesis(...) : null` 写进缓存，中间层落的全是 null，
  // 读回来仍是 null，于是永远重算同一组，实测空转 60 次也出不来报告。
  reset();
  diaries=Array.from({length:60},(_,i)=>make(`m${String(i).padStart(2,'0')}`,`第 ${i} 篇：判断必须回到原文，证据来自文本本身。`));
  let rounds=0, report=null;
  while(rounds++<80){ const r=await run(); if(r.status===200){ report=await r.text(); break; } }
  assert.ok(report,'必须在有限次内产出报告，不能停在中间层');
  assert(report.includes('60 篇公开文章'));
  // 必须真的产生中间层，否则这条用例在 buggy 代码上也会通过：
  // 40 篇时 40 个切块的综合输入塞得进一个 group，全程 0 个 group: 键，
  // 下面那句「中间层不能为 null」就永不生效（实测该场景下旧代码同样出报告）。
  const groupKeys=[...db.keys()].filter(k=>k.includes(':group:'));
  assert(groupKeys.length>0,`必须出现中间层 group 键，实际 ${groupKeys.length} 个`);
  assert(rounds>3,'应当经过提炼与多个综合层');
  // 中间层缓存里不能再出现 null
  assert(![...db.entries()].some(([k,v])=>k.includes(':group:')&&v==null),'中间层的值不能是 null');
 });
 await t.test('同长度改文只更新改动正文并使旧报告失效',async()=>{reset();await run();await run();diaries[0].summary=diaries[0].summary.replace('原文','现实');assert.equal((await run()).status,202);assert.equal((await run()).status,200);assert.equal(modelCalls,4);});
 await t.test('一次拒答只标记真正被拒的那一个切块，报告声明 1 篇而不是整批',async()=>{
  // 评审实测的缺陷：一个 12 块的提炼批次里只有 1 篇触发拒答，却写了跨 12 篇文章的 12 个标记，
  // 报告结尾写「另有 12 篇…未纳入」。这里要求收敛到那一个切块。
  reset();
  refuseMark='【触发拒答的段落】';
  diaries=Array.from({length:12},(_,i)=>make(`k${String(i).padStart(2,'0')}`,`第 ${i} 篇：判断必须回到原文。`));
  diaries[11].summary+=refuseMark;
  const corpus=makeCorpus(structuredClone(diaries));
  const guilty=corpus.chunks.find(c=>c.text.includes(refuseMark));
  assert(guilty,'材料里必须正好有一个切块会触发拒答');
  assert.equal(corpus.chunks.length,12,'12 篇短文正好是一个 12 块的提炼批次');
  assert.equal((await run()).status,202);
  assert.equal(skipKeys().length,1,`只该标记真正被拒的那一块，实际 ${skipKeys().length} 块`);
  assert(skipKeys()[0].endsWith(`:skip:${guilty.key}`),'标记必须落在真正被拒的切块上');
  assert(modelCalls>=2&&modelCalls<=9,`二分探测有上界（1 次原始失败 + ≤8 次探测），实际 ${modelCalls}`);
  // 标记之后进度必须继续：剩下的 11 块照常提炼，最终报告如实声明 1 篇未纳入
  let report=null;
  for(let round=0;round<6&&!report;round++){const r=await run();if(r.status===200)report=await r.text();}
  assert.ok(report,'被拒切块标记后必须能走到报告');
  assert.match(report,/另有 1 篇的部分正文被模型供应商的内容策略拒绝处理/);
  assert.doesNotMatch(report,/另有 12 篇/);
  assert(report.includes('12 篇公开文章'));
 });
 await t.test('拒答在读流期间才到达（流内错误形态）时同样收敛到单块，下次请求据此跳过',async()=>{
  reset();
  refuseMark='【触发拒答的段落】';refuseMode='stream';
  diaries=Array.from({length:4},(_,i)=>make(`s${i}`,`第 ${i} 篇：判断必须回到原文。`));
  diaries[3].summary+=refuseMark;
  const corpus=makeCorpus(structuredClone(diaries));
  const guilty=corpus.chunks.find(c=>c.text.includes(refuseMark));
  assert(guilty);
  const first=await run();
  assert.equal(first.status,202);
  assert.equal(skipKeys().length,1,`流内拒答同样只该标记 1 块，实际 ${skipKeys().length} 块`);
  assert(skipKeys()[0].endsWith(`:skip:${guilty.key}`));
  assert(modelCalls>=2&&modelCalls<=9,`探测次数必须有界，实际 ${modelCalls}`);
  // 下一次请求读回 skip 标记，视为已了结：剩余正文照常提炼，报告声明 1 篇未纳入
  let report=null;
  for(let round=0;round<4&&!report;round++){const r=await run();if(r.status===200)report=await r.text();}
  assert.ok(report,'跳过被拒切块后必须能走到报告');
  assert.match(report,/另有 1 篇的部分正文被模型供应商的内容策略拒绝处理/);
  assert.match(report,/已分析 4 篇公开文章/);
 });
 await t.test('二分探测遇到非拒答失败：不标记任何切块，按原样抛出',async()=>{
  reset();
  refuseMark='【触发拒答的段落】';networkFailAt=2; // 第 2 次调用（第一次探测）模拟网络失败
  diaries=Array.from({length:12},(_,i)=>make(`k${String(i).padStart(2,'0')}`,`第 ${i} 篇：判断必须回到原文。`));
  diaries[11].summary+=refuseMark;
  await assert.rejects(run(),/network down/);
  assert.equal(skipKeys().length,0,'网络失败绝不能被当成拒答去写排除标记');
  assert.equal(writes.length,0);
  assert(![...db.keys()].some(k=>k.endsWith('build-lock')),'锁必须释放');
 });
 await t.test('两半单独都能过时不猜：不写排除标记，原始拒答照常抛出',async()=>{
  reset();
  batchOnlyRefusal=true; // 只有整批 12 块被拒，任何子批次都能过 —— 归因不到具体切块
  diaries=Array.from({length:12},(_,i)=>make(`k${String(i).padStart(2,'0')}`,`第 ${i} 篇：判断必须回到原文。`));
  await assert.rejects(run(),/Content Exists Risk/);
  assert.equal(skipKeys().length,0,'归因不出来就不猜，宁可不写排除声明');
  assert(modelCalls<=9,`探测次数必须有界，实际 ${modelCalls}`);
 });
 await t.test('标记写入失败不吞掉拒答：请求失败、锁释放，不留半截状态',async()=>{
  reset();
  refuseMark='【触发拒答的段落】';pipelineBroken=true;
  diaries=[make('solo',`唯一一篇：判断必须回到原文。${refuseMark}`)];
  await assert.rejects(run(),/redis pipeline failed/);
  assert.equal(skipKeys().length,0);
  assert.equal(writes.length,0);
  assert(![...db.keys()].some(k=>k.endsWith('build-lock')),'锁必须释放');
  // Redis 恢复后同上请求能正常写下标记
  pipelineBroken=false;
  assert.equal((await run()).status,202);
  assert.equal(skipKeys().length,1);
 });
});
