import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamChatTools } from '../lib/persona/llm.ts';

/**
 * 工具协议流（streamChatTools）的方言与边界行为：
 * 分片拼接、缺 index 的兜底分槽、重复 name、批内 id 去重、finish_reason=length 截断处理、
 * tool_choice=none 透传。上游用 mock fetch 供给 SSE 文本，真实网络禁走。
 */
test('工具协议流：分片、方言与截断', async (t) => {
  const env = { PERSONA_LLM_API_KEY: 'offline-key', PERSONA_LLM_MODEL: 'offline-model', PERSONA_LLM_BASE_URL: 'https://llm.test.invalid', PERSONA_LLM_PROTOCOL: 'openai' };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  let packets = '';
  let lastBody = '';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    lastBody = String(init?.body ?? '');
    return new Response(packets, { headers: { 'Content-Type': 'text/event-stream' } });
  });

  const sse = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
  const read = async (over = {}) => {
    const stream = await streamChatTools({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], maxTokens: 100, ...over });
    const out = [];
    const reader = stream.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; out.push(value); }
    return out;
  };

  await t.test('常规：文本 + 按 index 分片聚合的工具调用', async () => {
    packets = sse([
      { choices: [{ delta: { content: '先查一下。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_blog', arguments: '{"que' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"普渡"}' } }] }, finish_reason: 'tool_calls' }] },
    ]);
    const out = await read();
    assert.deepEqual(out[0], { type: 'text', text: '先查一下。' });
    assert.deepEqual(out[1], { type: 'tool_calls', calls: [{ id: 'c1', name: 'search_blog', arguments: '{"query":"普渡"}' }] });
  });

  await t.test('缺 index 的方言：两条独立调用不得并成一条', async () => {
    packets = sse([
      { choices: [{ delta: { tool_calls: [{ id: 'a1', function: { name: 'search_blog', arguments: '{"query":"aa"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'a2', function: { name: 'blog_stats', arguments: '{}' } }] } }] },
    ]);
    const out = await read();
    const calls = out.find((e) => e.type === 'tool_calls').calls;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.name), ['search_blog', 'blog_stats']);
  });

  await t.test('每片重发完整 name：不得拼成 search_blogsearch_blog', async () => {
    packets = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'b1', function: { name: 'search_blog' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search_blog', arguments: '{"query":"aa"}' } }] } }] },
    ]);
    const out = await read();
    assert.equal(out[0].calls[0].name, 'search_blog');
  });

  await t.test('批内重复 id：自动去重保证唯一', async () => {
    packets = sse([
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'dup', function: { name: 'search_blog', arguments: '{"query":"aa"}' } },
        { index: 1, id: 'dup', function: { name: 'blog_stats', arguments: '{}' } },
      ] } }] },
    ]);
    const out = await read();
    const ids = out[0].calls.map((c) => c.id);
    assert.equal(new Set(ids).size, 2);
  });

  await t.test('finish_reason=length：截断的批不执行，以截断文案收尾', async () => {
    packets = sse([
      { choices: [{ delta: { content: '我先查' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'search_blog', arguments: '{"query":"普' } }] }, finish_reason: 'length' }] },
    ]);
    const out = await read();
    assert.ok(!out.some((e) => e.type === 'tool_calls'), '截断的批不得发出工具调用');
    assert.equal(out.filter((e) => e.type === 'text').map((e) => e.text).join(''), '我先查\n\n……篇幅有限，先说到这里。');
    assert.equal(out.at(-1).type, 'done');
  });

  await t.test('noMoreTools：tool_choice=none 透传上游', async () => {
    packets = sse([{ choices: [{ delta: { content: '好。' }, finish_reason: 'stop' }] }]);
    await read({ noMoreTools: true });
    assert.ok(lastBody.includes('"tool_choice":"none"'));
  });

  await t.test('续轮报文形状：assistant(tool_calls) 必须带 type:"function" 与 function 包裹', async () => {
    packets = sse([{ choices: [{ delta: { content: '好。' }, finish_reason: 'stop' }] }]);
    await read({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'search_blog', arguments: '{"query":"x"}' }] },
        { role: 'tool', tool_call_id: 'c1', content: '<untrusted_tool_result source="search_blog">\n{}\n</untrusted_tool_result>' },
      ],
    });
    const body = JSON.parse(lastBody);
    const asst = body.messages[2];
    assert.equal(asst.role, 'assistant');
    assert.equal(asst.tool_calls[0].type, 'function', 'DeepSeek 会以 400 拒绝缺 type 的 tool_calls');
    assert.equal(asst.tool_calls[0].function.name, 'search_blog');
    assert.equal(asst.tool_calls[0].function.arguments, '{"query":"x"}');
    assert.equal(asst.tool_calls[0].name, undefined, '线上报文不得带内部扁平字段');
    assert.equal(body.messages[3].role, 'tool');
    assert.equal(body.messages[3].tool_call_id, 'c1');
  });
});
