import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('@/') ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier, context);
}});
after(() => hooks.deregister());
const { makeCorpus, planAnalysis, validateExtraction, validateNote, validateSynthesis, renderAnalysis } = await import('../lib/persona/first-principles.ts');
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

test('中间归纳在最大字段长度下仍然收敛，过大的模型节点不会被提交',async()=>{
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
  if(!w.final)assert.throws(()=>validateSynthesis({findings:[...findings,findings[0]]},w,c));
  s.data.set(w.key,validateSynthesis({findings},w,c));calls++;
 }
 assert(done,'bounded reduction must converge'); assert(calls<40,`unexpected calls: ${calls}`);
});
