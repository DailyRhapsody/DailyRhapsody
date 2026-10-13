import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamChat } from '../lib/persona/llm.ts';

test('结构化分析仅接受模型协议明确正常结束',async t=>{
 const env={PERSONA_LLM_API_KEY:'offline-key',PERSONA_LLM_MODEL:'offline-model',PERSONA_LLM_BASE_URL:'https://llm.test.invalid',PERSONA_LLM_PROTOCOL:'openai'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 t.after(()=>{for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 let packets=[];
 t.mock.method(globalThis,'fetch',async()=>new Response(packets.map(p=>`data: ${JSON.stringify(p)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}}));
 const read=async strict=>new Response(await streamChat({system:'test',messages:[{role:'user',content:'test'}],maxTokens:50,strict})).text();
 packets=[{choices:[{delta:{content:'{"findings":[]}'},finish_reason:'stop'}]}];assert.equal(await read(true),'{"findings":[]}');
 packets=[{choices:[{delta:{content:'{"findings":[]}'},finish_reason:'length'}]}];await assert.rejects(read(true));assert((await read(false)).includes('篇幅有限'));
 packets=[{choices:[{delta:{content:'{"findings":[]}'}}]}];await assert.rejects(read(true));
 packets=[{error:{message:'offline failure'}}];await assert.rejects(read(true));
 process.env.PERSONA_LLM_PROTOCOL='anthropic';
 packets=[{type:'content_block_delta',delta:{type:'text_delta',text:'{}'}},{type:'message_delta',delta:{stop_reason:'end_turn'}}];assert.equal(await read(true),'{}');
 packets=[{type:'content_block_delta',delta:{type:'text_delta',text:'{}'}},{type:'message_delta',delta:{stop_reason:'max_tokens'}}];await assert.rejects(read(true));
});
