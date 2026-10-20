import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 每日一句的纯逻辑：种子名言按日轮换、北京时间的「今天」与到次日零点的 TTL、
 * 提示词只喂 public 包的画像段、模型输出清洗。路由层的缓存与并发在 daily-quote-route.test.mjs。
 */

const {
  DAILY_QUOTE_MAX_CHARS,
  SEED_QUOTES,
  dailyQuoteKey,
  dailyQuoteLockKey,
  dailyQuotePrompt,
  parseDailyQuote,
  pickSeedQuote,
  secondsUntilNextBeijingDay,
  todayInBeijing,
} = await import('../lib/persona/daily-quote.ts');

/** 人设包各段带哨兵，用来断言哪一段进了提示词 */
const bundle = {
  schema: 1,
  tier: 'public',
  builtAt: '2026-10-20T00:00:00Z',
  identity: '我是滕君，做过机器人调度平台的产品。',
  voice: '说话直接，不用客套。',
  logic: '先看约束，再谈方案。',
  memory: '我在工厂里待过，知道现场比文档复杂。',
  boundaries: '不谈家事与收入。',
  exemplars: [{ user: '你好', reply: '你好，随便聊。' }],
  notes: [{ id: 'n1', title: '笔记标题哨兵', text: '笔记正文哨兵' }],
  starters: ['最近在做什么'],
  avoidTags: [],
  avoidIds: [],
};

test('种子名言按日期轮换，且同一天稳定', () => {
  assert.equal(pickSeedQuote('2026-10-20').text, pickSeedQuote('2026-10-20').text);
  // 同月内相邻日期哈希加一，九天内不重复；跨月后仍要持续轮换
  const days = Array.from({ length: 9 }, (_, i) => `2026-11-0${i + 1}`);
  assert.equal(new Set(days.map(d => pickSeedQuote(d).text)).size, 9, '九天里不该重复');
  const month = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));
  assert(new Set(month.map(d => pickSeedQuote(d).text)).size >= 8, '两个月里应覆盖多数名言');
  // 相邻两天不给同一条，读者不会连着两天看到同一句的依据
  assert.notEqual(pickSeedQuote('2026-10-20').text, pickSeedQuote('2026-10-21').text);
  for (const q of SEED_QUOTES) {
    assert(q.text.trim() && q.author.trim(), '种子名言必须有原文与作者');
  }
});

test('「今天」按北京时间算，TTL 到次日零点', () => {
  // 2026-10-19T16:30Z 是北京时间 2026-10-20 00:30
  assert.equal(todayInBeijing(new Date('2026-10-19T16:30:00Z')), '2026-10-20');
  assert.equal(secondsUntilNextBeijingDay(new Date('2026-10-19T16:00:00Z')), 86_400);
  // 不足一分钟的 TTL 等于刚写就过期，下限取 60 秒
  assert.equal(secondsUntilNextBeijingDay(new Date('2026-10-20T15:59:59Z')), 60);
  // 无论什么时候取，都给下一次请求留出正数 TTL
  assert(secondsUntilNextBeijingDay(new Date()) >= 60);
});

test('缓存键带版本与日期，锁键落在同一天名下', () => {
  const key = dailyQuoteKey('2026-10-20');
  assert.match(key, /daily-quote:v\d+:2026-10-20$/);
  assert.equal(dailyQuoteLockKey('2026-10-20'), `${key}:lock`);
  assert.notEqual(dailyQuoteKey('2026-10-20'), dailyQuoteKey('2026-10-21'));
});

test('提示词只喂画像段：identity/logic/memory 进，boundaries/notes/exemplars 不进', () => {
  const seed = pickSeedQuote('2026-10-20');
  const prompt = dailyQuotePrompt(bundle, seed, '2026-10-20');
  assert(prompt.includes('2026-10-20'));
  assert(prompt.includes(bundle.identity));
  assert(prompt.includes(bundle.logic));
  assert(prompt.includes(bundle.memory));
  assert(prompt.includes(seed.text) && prompt.includes(seed.author));
  for (const hidden of [bundle.boundaries, '笔记标题哨兵', '笔记正文哨兵', bundle.starters[0]]) {
    assert(!prompt.includes(hidden), `不该进提示词：${hidden}`);
  }
  // 不署名、不出现人名，是「重写成新句子」的前提
  assert(prompt.includes('不署名'), '提示词必须禁止署名');
  assert(prompt.includes('只输出这句话本身'));
});

test('模型输出清洗：去包装、去署名、取一行', () => {
  assert.equal(parseDailyQuote('好的判断来自现场，而不是来自文档。'), '好的判断来自现场，而不是来自文档。');
  assert.equal(parseDailyQuote('每日一句：先看约束，再谈方案。'), '先看约束，再谈方案。');
  assert.equal(parseDailyQuote('「先看约束，再谈方案。」'), '先看约束，再谈方案。');
  assert.equal(parseDailyQuote('“先看约束，再谈方案。”'), '先看约束，再谈方案。');
  assert.equal(parseDailyQuote('先看约束，再谈方案。——尼采'), '先看约束，再谈方案。');
  assert.equal(parseDailyQuote('**先看约束，再谈方案。**'), '先看约束，再谈方案。');
  assert.equal(parseDailyQuote('先看约束，再谈方案。\n这句是解释'), '先看约束，再谈方案。');
  // 感叹号、问号统一成陈述句的句号
  assert.equal(parseDailyQuote('先看约束，再谈方案！'), '先看约束，再谈方案。');
  assert.equal(parseDailyQuote('先看约束，再谈方案？'), '先看约束，再谈方案。');
});

test('不合格的输出一律返回 null：宁可不显示，也不挂半句到宠物头上', () => {
  assert.equal(parseDailyQuote(''), null);
  assert.equal(parseDailyQuote('   '), null);
  assert.equal(parseDailyQuote(null), null);
  assert.equal(parseDailyQuote({ text: '先看约束' }), null);
  assert.equal(parseDailyQuote('短句'), null);
  assert.equal(parseDailyQuote('抱歉，我不能写这句话。'), null);
  assert.equal(parseDailyQuote('。'), null);
  assert.equal(parseDailyQuote('长'.repeat(DAILY_QUOTE_MAX_CHARS + 1)), null);
  assert.equal(parseDailyQuote('长'.repeat(DAILY_QUOTE_MAX_CHARS)), '长'.repeat(DAILY_QUOTE_MAX_CHARS));
});
