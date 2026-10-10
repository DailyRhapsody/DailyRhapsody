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
 const make=(id,text=`证据${id}：判断必须回到原文。`)=>({id,date:'2026-10-08',summary:text,isPublic:true,bodyStatus:'complete'});
 let diaries=[make('a'),make('b')];
 t.mock.module(new URL('../lib/notion.ts',import.meta.url).href,{exports:{getAnalysisDiaries:async()=>{sourceCalls++;return diaries===null?null:structuredClone(diaries);}}});
 t.mock.module(new URL('../lib/request-guard.ts',import.meta.url).href,{exports:{withAntiScrapeHeaders:r=>r}});
 t.mock.module('@upstash/redis',{exports:{Redis:class{
  async mget(...keys){return keys.map(k=>structuredClone(db.get(k)??null));}
  async set(k,v,opts){if(opts?.nx&&db.has(k))return null;db.set(k,structuredClone(v));return 'OK';}
  pipeline(){const queued=[];return {set(k,v){queued.push([k,v]);return this;},async exec(){for(const[k,v]of queued){db.set(k,structuredClone(v));writes.push(k);}return queued.map(()=> 'OK');}};}
  async eval(_,[key],[token]){return db.get(key)===token?Number(db.delete(key)):0;}
 }}});
 t.mock.module(new URL('../lib/persona/llm.ts',import.meta.url).href,{exports:{streamChat:async opts=>{
  modelCalls++;assert.equal(opts.strict,true);assert(opts.signal);if(gate)await gate.promise;
  const input=JSON.parse(opts.messages[0].content);
  const raw=Array.isArray(input)?input.map(c=>({key:c.key,findings:[{kind:'premise',claim:'判断须有证据。',evidence:[{chunk:c.key,quote:c.text.slice(-80)}],boundary:'仅据文本归纳。'}]})):{findings:input.notes.flatMap(n=>n.findings).slice(0,6)};
  if(changeDuringModel)diaries=diaries.filter(d=>d.id!=='a');
  return new ReadableStream({start(c){if(broken){c.error(new Error('interrupted'));return;}c.enqueue(new TextEncoder().encode(JSON.stringify(raw)));c.close();}});
 }}});
 const {runFirstPrinciples}=await import('../lib/persona/first-principles-route.ts');
 const request=()=>new Request('http://local.test/api/chat',{method:'POST',body:'{}'});
 const auth=async()=>{authorizeCalls++;return null;};
 const run=()=>runFirstPrinciples(request(),auth);
 const reset=()=>{db.clear();writes.length=0;diaries=[make('a'),make('b')];modelCalls=0;authorizeCalls=0;changeDuringModel=false;broken=false;gate=undefined;};
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
 await t.test('同长度改文只更新改动正文并使旧报告失效',async()=>{reset();await run();await run();diaries[0].summary=diaries[0].summary.replace('原文','现实');assert.equal((await run()).status,202);assert.equal((await run()).status,200);assert.equal(modelCalls,4);});
});
