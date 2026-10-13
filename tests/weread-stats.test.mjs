// node --test tests/weread-stats.test.mjs
//
// 微信读书阅读数据的纯函数与降级行为。
//
// 字段口径以腾讯官方 skill 文档为准（Tencent/WeChatReading，skills/readdata.md，v1.0.5），
// 两处最容易写错的地方各有专门用例：
//   totalReadTime 单位是秒；readTimes 的 key 是分桶起始时间戳（秒），不是日期字符串。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeDaily,
  buildReadingStats,
  getReadingStats,
  fetchReadingStats,
  refreshReadingStats,
} from "../lib/weread.ts";

/** 2026-10-01 00:00 本地时间的时间戳（秒），与真实回包的 baseTime 一致 */
const OCT_1 = Math.floor(new Date(2026, 9, 1).getTime() / 1000);
const day = (n) => OCT_1 + (n - 1) * 86400;

// ---------------------------------------------------------------------------
// normalizeDaily：逐日归一
// ---------------------------------------------------------------------------

test("时间戳 key 按本地日落到正确的天，缺日补 0", () => {
  const out = normalizeDaily({ [day(1)]: 4206, [day(8)]: 4761, [day(9)]: 1664 }, "2026-10", 31);
  assert.equal(out.length, 31);
  assert.equal(out[0], 70, "1 日 4206 秒 → 70 分钟");
  assert.equal(out[7], 79, "8 日 4761 秒 → 79 分钟");
  assert.equal(out[8], 28);
  assert.equal(out.filter((v) => v === 0).length, 28, "其余补 0");
});

test("只画到已过去的天数，未来的日子不补点", () => {
  const out = normalizeDaily({ [day(1)]: 600 }, "2026-10", 12);
  assert.equal(out.length, 12, "10 月 12 日应只得到 12 个点");
});

test("已过天数超过当月天数时按当月天数截断", () => {
  assert.equal(normalizeDaily({}, "2026-02", 31).length, 28);
  assert.equal(normalizeDaily({}, "2028-02", 31).length, 29, "2028 是闰年");
});

test("同样接受 YYYY-MM-DD 与 YYYYMMDD 日键", () => {
  assert.equal(normalizeDaily({ "2026-10-05": 120 }, "2026-10", 31)[4], 2);
  assert.equal(normalizeDaily({ "20261005": 120 }, "2026-10", 31)[4], 2);
});

test("超出已过天数的桶被忽略，不越界写入", () => {
  const out = normalizeDaily({ [day(20)]: 600 }, "2026-10", 12);
  assert.deepEqual(out, new Array(12).fill(0));
});

test("非法值与非法 key 被忽略", () => {
  const out = normalizeDaily(
    { nope: 600, [day(1)]: -5, [day(2)]: "abc" },
    "2026-10",
    31,
  );
  assert.deepEqual(out, new Array(31).fill(0));
});

test("接受 {readTime} 形式的桶值", () => {
  assert.equal(normalizeDaily({ [day(7)]: { readTime: 90 } }, "2026-10", 31)[6], 2);
});

test("非对象输入返回全 0 而不抛异常", () => {
  for (const bad of [null, undefined, 42, "x"]) {
    assert.deepEqual(normalizeDaily(bad, "2026-10", 31), new Array(31).fill(0));
  }
});

// ---------------------------------------------------------------------------
// buildReadingStats：fail closed
// ---------------------------------------------------------------------------

test("缺少总时长即返回 null，不编造数字", () => {
  assert.equal(buildReadingStats(null, null), null);
  assert.equal(buildReadingStats({}, null), null);
  assert.equal(buildReadingStats({ readDays: 3 }, null), null);
  assert.equal(buildReadingStats({ totalReadTime: 0 }, null), null);
  assert.equal(buildReadingStats({ totalReadTime: -60 }, null), null);
  assert.equal(buildReadingStats({ totalReadTime: "abc" }, null), null);
});

test("秒换算成分钟，不是分钟或小时", () => {
  const s = buildReadingStats({ totalReadTime: 11685 }, null);
  assert.equal(s.monthMinutes, 195, "11685 秒 = 194.75 分 → 195 分");
});

test("最小可用回包得到完整结构", () => {
  const s = buildReadingStats({ totalReadTime: 600, readDays: 4 }, null);
  assert.equal(s.monthMinutes, 10);
  assert.equal(s.monthDays, 4);
  assert.ok(Array.isArray(s.daily) && s.daily.length >= 1);
  assert.deepEqual(s.books, []);
  assert.deepEqual(s.preferences, []);
  assert.match(s.month, /^\d{4}-\d{2}$/);
  assert.ok(Number.isFinite(s.refreshedAt));
});

// ---------------------------------------------------------------------------
// 读得最多的书
// ---------------------------------------------------------------------------

test("不在解析层截断条数（上限交给卡片按高度决定），有声内容走 albumInfo", () => {
  const s = buildReadingStats({
    totalReadTime: 3600,
    readLongest: [
      { book: { title: "A" }, readTime: 600 },
      { albumInfo: { name: "有声B" }, readTime: 500 },
      { book: { title: "C" }, readTime: 400 },
      { book: { title: "D" }, readTime: 300 },
    ],
  }, null);
  assert.deepEqual(
    s.books.map((b) => [b.title, b.minutes, Boolean(b.album)]),
    [["A", 10, false], ["有声B", 8, true], ["C", 7, false], ["D", 5, false]],
  );
});

test("albumInfo 只有 title 时也能取到书名", () => {
  const s = buildReadingStats(
    { totalReadTime: 600, readLongest: [{ albumInfo: { title: "专辑" }, readTime: 300 }] },
    null,
  );
  assert.equal(s.books[0].title, "专辑");
  assert.equal(s.books[0].album, true);
});

test("无书名的条目被跳过，不让空洞进入排行", () => {
  const s = buildReadingStats(
    { totalReadTime: 600, readLongest: [{ book: {}, readTime: 600 }, { book: { title: "有效" }, readTime: 400 }] },
    null,
  );
  assert.deepEqual(s.books.map((b) => b.title), ["有效"]);
});

test("时长解析不了时记为 0，不丢弃这条书目", () => {
  const s = buildReadingStats(
    { totalReadTime: 600, readLongest: [{ book: { title: "无时长" } }] },
    null,
  );
  assert.deepEqual(s.books, [{ title: "无时长", minutes: 0, album: false }]);
});

test("形如「5小时30分钟」的格式化时长可解析", () => {
  const s = buildReadingStats(
    { totalReadTime: 600, readLongest: [{ book: { title: "格式化" }, readTime: "5小时30分钟" }] },
    null,
  );
  assert.equal(s.books[0].minutes, 330);
});

test("书目只取本月榜，累计榜不参与书目", () => {
  const s = buildReadingStats(
    { totalReadTime: 600, readLongest: [{ book: { title: "本月" }, readTime: 300 }] },
    { readLongest: [{ book: { title: "累计" }, readTime: 900 }] },
  );
  assert.deepEqual(s.books.map((b) => b.title), ["本月"]);
});

test("摘要拼成一行，并过滤掉零值项", () => {
  const s = buildReadingStats({
    totalReadTime: 11685,
    readStat: [
      { stat: "读过", counts: "1本" },
      { stat: "读完", counts: "0本" },
      { stat: "阅读", counts: "4天" },
      { stat: "笔记", counts: "0条" },
    ],
  }, null);
  assert.equal(s.summary, "读过 1本 · 阅读 4天");
});

test("摘要字段异常时为空串，不抛异常", () => {
  assert.equal(buildReadingStats({ totalReadTime: 600 }, null).summary, "");
  assert.equal(buildReadingStats({ totalReadTime: 600, readStat: "x" }, null).summary, "");
  assert.equal(
    buildReadingStats({ totalReadTime: 600, readStat: [null, 42, {}] }, null).summary,
    "",
  );
});

// ---------------------------------------------------------------------------
// 累计偏好：每类取前 2 名
// ---------------------------------------------------------------------------

test("偏好只取有阅读时长的分类，占位分类被过滤", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferCategory: [
      { categoryTitle: "社会小说", readingTime: 11685 },
      { categoryTitle: "个人成长", readingTime: 0 },
      { categoryTitle: "历史", readingTime: 0 },
    ],
    preferAuthor: [{ name: "苏杰", count: 4 }, { name: "泰戈尔", count: 2 }],
    preferPublisher: [{ name: "中信出版集团", count: 32 }, { name: "文学出版社", count: 5 }],
  });
  assert.deepEqual(s.preferences, [
    { label: "分类", value: "社会小说" },
    { label: "作者", value: "苏杰" },
    { label: "出版社", value: "中信出版集团" },
  ]);
});

test("每类只取权重最高的一名，不按数组顺序", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferCategory: [
      { categoryTitle: "文学", readingTime: 100 },
      { categoryTitle: "经济理财", readingTime: 900 },
      { categoryTitle: "历史", readingTime: 500 },
      { categoryTitle: "哲学宗教", readingTime: 50 },
    ],
  });
  assert.deepEqual(s.preferences, [{ label: "分类", value: "经济理财" }]);
});

test("作者与出版社按本数取最高", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [{ name: "少", count: 1 }, { name: "多", count: 9 }, { name: "中", count: 5 }],
    preferPublisher: [{ name: "少社", count: 2 }, { name: "多社", count: 20 }],
  });
  assert.deepEqual(s.preferences, [
    { label: "作者", value: "多" },
    { label: "出版社", value: "多社" },
  ]);
});

test("累计周期缺失或为空时偏好留空，卡片相应少一屏", () => {
  assert.deepEqual(buildReadingStats({ totalReadTime: 600 }, null).preferences, []);
  assert.deepEqual(buildReadingStats({ totalReadTime: 600 }, {}).preferences, []);
});

test("偏好字段形态异常时不抛异常", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferCategory: "不是数组",
    preferAuthor: [null, 42],
    preferPublisher: [{}, { name: 123 }],
  });
  assert.deepEqual(s.preferences, []);
});

// ---------------------------------------------------------------------------
// 累计阅读时段
// ---------------------------------------------------------------------------

test("时段取 24 个点，文案一并带出", () => {
  const hourly = Array.from({ length: 24 }, (_, i) => (i === 18 ? 236834 : 1000));
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferTime: hourly,
    preferTimeWord: "偏好夜间阅读",
  });
  assert.equal(s.hourly.length, 24);
  assert.equal(s.hourly[18], 236834);
  assert.equal(s.hourlyWord, "偏好夜间阅读");
  // 下标 18 对应 (6+18)%24 = 0 时，即峰值出现在午夜
  assert.equal((6 + s.hourly.indexOf(Math.max(...s.hourly))) % 24, 0);
});

test("时段全为 0 视为无数据，卡片少一屏", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferTime: new Array(24).fill(0),
    preferTimeWord: "偏好夜间阅读",
  });
  assert.deepEqual(s.hourly, []);
  assert.equal(s.hourlyWord, "");
});

test("时段缺失或形态异常时不抛异常", () => {
  for (const bad of [undefined, null, "x", 42]) {
    const s = buildReadingStats({ totalReadTime: 600 }, { preferTime: bad });
    assert.deepEqual(s.hourly, []);
    assert.equal(s.hourlyWord, "");
  }
});

test("时段多于 24 项时截断，负数与非数字归零", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferTime: [...new Array(30).fill(60), -5, "abc"],
  });
  assert.equal(s.hourly.length, 24);
  assert.ok(s.hourly.every((v) => v === 60));
});

// ---------------------------------------------------------------------------
// 降级：不得抛异常，不得误报成功
// ---------------------------------------------------------------------------

test("未配置 WEREAD_API_KEY 时刷新返回 skipped、取数返回 null，均不抛异常", async () => {
  const saved = process.env.WEREAD_API_KEY;
  delete process.env.WEREAD_API_KEY;
  try {
    assert.equal(await refreshReadingStats(), "skipped");
    assert.equal(await fetchReadingStats(), null);
  } finally {
    if (saved !== undefined) process.env.WEREAD_API_KEY = saved;
  }
});

test("空白 WEREAD_API_KEY 同样按未配置处理", async () => {
  const saved = process.env.WEREAD_API_KEY;
  process.env.WEREAD_API_KEY = "   ";
  try {
    assert.equal(await refreshReadingStats(), "skipped");
    assert.equal(await fetchReadingStats(), null);
  } finally {
    if (saved !== undefined) process.env.WEREAD_API_KEY = saved;
    else delete process.env.WEREAD_API_KEY;
  }
});

test("既无 Redis 凭证也无网关 Key 时返回 null，不抛异常", async () => {
  // 必须连 WEREAD_API_KEY 一起清掉：无 Redis 时会回源到网关，
  // 若环境里带着真实 Key（例如在同一 shell 里 source 过 .env.local），
  // 这个用例会真的发出网络请求并拿到数据，断言随之失败。
  const keys = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "WEREAD_API_KEY",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    assert.equal(await getReadingStats(), null);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
