import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

// 目录是纯数据，runner 表会牵出实现（node:crypto、@upstash/redis、next/server），
// 所以两者用同一套 @/ 解析钩子导入。
const hooks = registerHooks({
  resolve(s, c, n) {
    return n(s === 'next/server' ? 'next/server.js' : s.startsWith('@/') ? new URL(`../${s.slice(2)}.ts`, import.meta.url).href : s, c);
  },
});
test.after(() => hooks.deregister());

const { SKILLS, findSkill } = await import('../lib/persona/skills.ts');
const { SKILL_RUNNERS, skillRunner } = await import('../lib/persona/skill-runners.ts');
const { IncompleteAnalysisSourceError } = await import('../lib/notion.ts');

const QUOTAS = new Set(['analysis']);

test('目录里的每条 skill 字段完整，且 id 唯一', () => {
  assert.ok(SKILLS.length > 0, '目录不能为空');
  const ids = new Set();
  for (const skill of SKILLS) {
    for (const field of ['id', 'label', 'hint', 'progress', 'prompt', 'failure']) {
      assert.equal(typeof skill[field], 'string', `${skill.id} 的 ${field} 必须是字符串`);
      assert.ok(skill[field].trim().length > 0, `${skill.id} 的 ${field} 不能为空`);
    }
    assert.ok(QUOTAS.has(skill.quota), `${skill.id} 的额度类型未登记`);
    assert.ok(!ids.has(skill.id), `id 重复：${skill.id}`);
    ids.add(skill.id);
  }
});

test('查表只认登记过的 id，非字符串一律拒绝', () => {
  assert.equal(findSkill('first-principles')?.id, 'first-principles');
  for (const bad of [undefined, null, '', 'nope', 42, {}, [], true]) {
    assert.equal(findSkill(bad), null, `${JSON.stringify(bad)} 不该被接受`);
  }
  // 面板与路由都靠它把关：目录里没有的 id 不能被放行
  assert.ok(!SKILLS.some((s) => s.id === 'nope'));
});

test('runner 表对目录穷举，没有孤儿也没有漏登记', () => {
  const registered = Object.keys(SKILL_RUNNERS);
  assert.equal(registered.length, SKILLS.length, 'runner 数与目录条数必须一致');
  for (const skill of SKILLS) {
    const runner = skillRunner(skill.id);
    assert.equal(typeof runner?.run, 'function', `${skill.id} 缺少可执行实现`);
    assert.equal(runner, SKILL_RUNNERS[skill.id]);
  }
});

test('第一性原理洞察自己认领正文不完整的失败，其余交给通用文案', async () => {
  const runner = skillRunner('first-principles');

  const failure = runner.failure?.(new IncompleteAnalysisSourceError(3));
  assert.equal(failure?.status, 422);
  assert.match(failure.error, /3 篇/);

  // 认不出来的异常返回 null，由路由回落到目录里的 failure 文案
  assert.equal(runner.failure?.(new Error('boom')), null);
  assert.equal(runner.failure?.('not an error'), null);

  const meta = findSkill('first-principles');
  assert.match(meta.failure, /进度/);
});

test('对外名称是「第一性原理洞察」，协议 id 保持不变', () => {
  const meta = findSkill('first-principles');
  assert.equal(meta.label, '第一性原理洞察');
  // id 会写进访客历史，改名会让旧会话对不上号；这里锁死，改之前必须想清楚
  assert.equal(meta.id, 'first-principles');
  assert.equal(meta.quota, 'analysis');
});

test('目录必须保持客户端安全：不得出现运行期 import', async () => {
  // 目录会被打进浏览器产物，实现不会。这条守卫防的是「顺手 import 一个服务端模块」——
  // 那种改动 next build 不会报错（@/lib/notion 这类真实模块能解析），
  // 服务端代码会静默进客户端包。只允许 import type（编译后消失）。
  const src = await readFile(new URL('../lib/persona/skills.ts', import.meta.url), 'utf8');
  const runtime = [...src.matchAll(/^\s*import\s+(?!type\b)[^\n]*/gm)].map((m) => m[0].trim());
  assert.deepEqual(runtime, [], `skills.ts 出现了运行期 import：${runtime.join(' | ')}`);
});

test('SkillId 必须保持字面量联合，否则「漏登记就编译失败」会静默失效', async () => {
  // as const 一旦被当作冗余删掉，SkillId 拓宽成 string，Record<SkillId, SkillRunner>
  // 退化为 Record<string, …>，而 tsc / 单测 / build 会全部通过。skills.ts 里的编译期
  // 断言就是拦这个的，这里断言它还在，防止有人「顺手」把断言也一起删了。
  const src = await readFile(new URL('../lib/persona/skills.ts', import.meta.url), 'utf8');
  assert.match(src, /\]\s*as\s+const\s+satisfies\s+readonly\s+SkillMeta\[\]/,
    'as const 被删了：SkillId 会被拓宽成 string');
  assert.match(src, /AssertTrue<string extends SkillId \? false : true>/,
    '字面量断言被删了：拓宽后将无人报警');
});

test('runner 依赖图不得触达人设包、提示词与鉴权', async () => {
  // SkillContext 不给人设包只是接口形状，不是边界：import 一行就能绕过去。
  // 这里做成会失败的守卫，而不是靠约定。getCachedDiaries 尤其要盯——
  // 它返回未过滤缓存（含 isPublic === false 的私域文章），而 lib/notion.ts
  // 本来就在依赖图里，改一个词就能拿到。
  const forbidden = ['@/lib/persona/store', '@/lib/persona/prompt', '@/lib/auth', 'getCachedDiaries'];
  for (const file of ['skill-runners.ts', 'first-principles-route.ts', 'first-principles.ts']) {
    const src = await readFile(new URL(`../lib/persona/${file}`, import.meta.url), 'utf8');
    for (const bad of forbidden) {
      assert.ok(!src.includes(bad), `${file} 不得引用 ${bad}`);
    }
  }
});
