// node --test tests/weread-stats.test.mjs
//
// 微信读书阅读数据的纯函数与降级行为。
//
// 字段口径以腾讯官方 skill 文档为准（Tencent/WeChatReading，skills/readdata.md，v1.0.5），
// 两处最容易写错的地方各有专门用例：
//   totalReadTime 单位是秒；readTimes 的 key 是分桶起始时间戳（秒），不是日期字符串。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  layoutCloud,
  estimateWordWidth,
} from "../lib/reading-cloud-layout.ts";
import { isUsableCachedStats } from "../lib/weread.ts";
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
// 云图轮播：作者两屏（preferAuthor / preferCategory）
// ---------------------------------------------------------------------------

test("作者云图第 1 屏取 preferAuthor，按 readTime 字符串加权而不是按本数", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    // 本数与时长故意反向：苏杰 4 本但 1 小时，赫拉利 3 本却 46 小时
    preferAuthor: [
      { name: "苏杰", count: 4, readTime: "1小时0分钟" },
      { name: "尤瓦尔·赫拉利", count: 3, readTime: "46小时50分钟" },
    ],
  });
  assert.deepEqual(s.authorClouds, [
    {
      label: "作者 · 按累计阅读时长",
      words: [
        { name: "尤瓦尔·赫拉利", weight: 100, note: "46h 50m" },
        { name: "苏杰", weight: 2.1, note: "1h" },
      ],
    },
  ]);
});

test("作者 readTime 为纯数字时按秒处理，不按分钟", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [{ name: "甲", readTime: 3600 }],
  });
  assert.equal(s.authorClouds[0].words[0].note, "1h", "3600 秒应读成 1 小时");
});

test("作者云图按权重倒序，接口给什么顺序都不影响", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [
      { name: "少", readTime: "1小时0分钟" },
      { name: "多", readTime: "9小时0分钟" },
      { name: "中", readTime: "5小时0分钟" },
    ],
  });
  assert.deepEqual(s.authorClouds[0].words.map((w) => w.name), ["多", "中", "少"]);
  assert.deepEqual(s.authorClouds[0].words.map((w) => w.weight), [100, 55.6, 11.1]);
});

test("并列权重按名称定序，同一天两次拉取不会给出不同顺序", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [
      { name: "乙", readTime: "3小时0分钟" },
      { name: "甲", readTime: "3小时0分钟" },
    ],
  });
  assert.deepEqual(
    s.authorClouds[0].words.map((w) => w.name).sort(),
    ["乙", "甲"].sort(),
  );
  // 两次构建结果必须一致，否则缓存内容会抖
  const again = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [
      { name: "甲", readTime: "3小时0分钟" },
      { name: "乙", readTime: "3小时0分钟" },
    ],
  });
  assert.deepEqual(again.authorClouds[0].words, s.authorClouds[0].words);
});

test("第 3 屏取 preferCategory，按累计阅读时长加权", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferCategory: [
      { categoryTitle: "经济理财", readingTime: 1055114 },
      { categoryTitle: "文学", readingTime: 415151 },
      { categoryTitle: "占位分类", readingTime: 0 },
    ],
  });
  assert.deepEqual(s.authorClouds, [
    {
      label: "阅读分类 · 按时长",
      words: [
        { name: "经济理财", weight: 100, note: "293h 5m" },
        { name: "文学", weight: 39.3, note: "115h 19m" },
      ],
    },
  ]);
});

test("作者卡两屏：先 preferAuthor 后 preferCategory", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [{ name: "作者甲", readTime: "1小时0分钟" }],
    // readLongest 那一屏已按需求删掉，即便接口给了数据也不再出屏
    readLongest: [{ book: { author: "作者乙" }, readTime: 3600 }],
    preferCategory: [{ categoryTitle: "文学", readingTime: 3600 }],
  });
  assert.deepEqual(s.authorClouds.map((c) => c.label), [
    "作者 · 按累计阅读时长",
    "阅读分类 · 按时长",
  ]);
});

test("每屏各自归一到 100，屏与屏之间不互相参照", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [{ name: "甲", readTime: "100小时0分钟" }],
    preferCategory: [{ categoryTitle: "文学", readingTime: 60 }],
  });
  // 60 秒的分类也该是本屏第一，而不是被作者的 100 小时压成 0.0
  assert.deepEqual(s.authorClouds.map((c) => c.words[0].weight), [100, 100]);
});

test("同名作者去重取较大权重，不出现两个字号不同的同名词", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [
      { name: "苏杰", readTime: "2小时0分钟" },
      { name: "苏杰", readTime: "8小时0分钟" },
    ],
  });
  assert.equal(s.authorClouds[0].words.length, 1);
  assert.equal(s.authorClouds[0].words[0].note, "8h");
});

test("作者屏最多 4 个词、出版社屏最多 3 个（按卡片内容盒面积定的），截断发生在排序之后", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ name: `作者${i}`, readTime: `${i + 1}小时0分钟` }));
  const s = buildReadingStats({ totalReadTime: 600 }, { preferAuthor: many });
  assert.equal(s.authorClouds[0].words.length, 4);
  assert.equal(s.authorClouds[0].words[0].name, "作者13");
  const pubs = Array.from({ length: 14 }, (_, i) => ({ name: `社${i}`, count: 20 - i }));
  const p = buildReadingStats({ totalReadTime: 600 }, { preferPublisher: pubs });
  assert.equal(p.publisherClouds.length, 1, "出版社只出一屏");
  assert.equal(p.publisherClouds[0].words.length, 3);
  assert.equal(p.publisherClouds[0].words[0].name, "社0");
});

// ---------------------------------------------------------------------------
// 云图轮播：出版社两屏（preferPublisher ∪ preferCp）
// ---------------------------------------------------------------------------

test("出版社两处来源合并去重，同名取较大本数", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferPublisher: [{ name: "中信出版集团", count: 32 }, { name: "电子工业出版社", count: 18 }],
    // preferCp 名字藏在 copyrightInfo 里，且同名计数更小，应被 preferPublisher 的 18 压住
    preferCp: [
      { count: 30, copyrightInfo: { name: "中信出版集团" } },
      { count: 17, copyrightInfo: { name: "电子工业出版社" } },
      { count: 9, copyrightInfo: { name: "读客熊猫君阅读" } },
    ],
  });
  assert.deepEqual(s.publisherClouds[0].words, [
    { name: "中信出版集团", weight: 100, note: "32 本" },
    { name: "电子工业出版社", weight: 56.3, note: "18 本" },
    { name: "读客熊猫君阅读", weight: 28.1, note: "9 本" },
  ]);
});

test("出版社只出一屏，取前 3 家", () => {
  const many = Array.from({ length: 16 }, (_, i) => ({ name: `出版社${String(i).padStart(2, "0")}`, count: 20 - i }));
  const s = buildReadingStats({ totalReadTime: 600 }, { preferPublisher: many });
  assert.equal(s.publisherClouds.length, 1);
  assert.equal(s.publisherClouds[0].label, "出版社 · 读得最多");
  assert.deepEqual(s.publisherClouds[0].words.map((w) => w.name), [
    "出版社00",
    "出版社01",
    "出版社02",
  ]);
  // 20/19/18 本 → 100 / 95 / 90（按组内最大值归一到 0~100）
  assert.deepEqual(s.publisherClouds[0].words.map((w) => w.weight), [100, 95, 90]);
});

// ---------------------------------------------------------------------------
// 云图：异常输入与整体空数据
// ---------------------------------------------------------------------------

test("负时长被拒，含 Unicode 减号与破折号", () => {
  // 回归用例：parseFormattedDuration 的正则不含符号位，`"-5小时"` 曾被读成 +5 小时；
  // 只挡 ASCII 连字符时，`"−5小时"`（U+2212）仍会被读成正数，因此符号要认全。
  const bad = [
    "-5小时0分钟",
    "-30分钟",
    "\u22125小时", // U+2212 数学减号
    "\u20135小时", // U+2013 短破折号
    "\u20145小时", // U+2014 长破折号
    "5小时-30分钟", // 后段带负号，取负意图无法可靠区分，整条拒掉
    " -0小时30分钟",
  ];
  for (const readTime of bad) {
    const s = buildReadingStats({ totalReadTime: 600 }, { preferAuthor: [{ name: "X", readTime }] });
    assert.deepEqual(
      s.authorClouds[0]?.words ?? [],
      [],
      `${JSON.stringify(readTime)} 应被拒`,
    );
  }
  // 正常值不受影响
  for (const [readTime, note] of [["0小时30分钟", "30m"], ["30分钟", "30m"], ["2小时0分钟", "2h"]]) {
    const s = buildReadingStats({ totalReadTime: 600 }, { preferAuthor: [{ name: "Y", readTime }] });
    assert.equal(s.authorClouds[0].words[0].note, note, `${readTime} 应解析为 ${note}`);
  }
});

test("缓存形状校验与构建器同口径，不误杀合法缓存", () => {
  const good = buildReadingStats({ totalReadTime: 600 }, { preferAuthor: [{ name: "甲", readTime: "1小时0分钟" }] });
  assert.equal(isUsableCachedStats(good), true, "正常对象必须通过");
  assert.equal(isUsableCachedStats({ ...good, authorClouds: undefined }), false, "缺云图数组的旧结构必须拒");
  assert.equal(isUsableCachedStats({ ...good, publisherClouds: null }), false);
  assert.equal(isUsableCachedStats({ ...good, monthMinutes: 0 }), false, "与构建器一致：总时长为 0 不接受");
  assert.equal(isUsableCachedStats({ ...good, monthMinutes: -1 }), false);
  // 空数组是合法状态（当月没读到书、时段未达阈值），不能因此回源
  assert.equal(isUsableCachedStats({ ...good, books: [], hourly: [] }), true);
  for (const bad of [null, undefined, "x", 42, {}]) {
    assert.equal(isUsableCachedStats(bad), false);
  }
});

test("带前缀的时长串也能解析（全串扫描，不是只匹配 index 0）", () => {
  // 回归用例：时长段可空时正则会在 index 0 匹配空串、exec 不再向后找，
  // 于是 `"总计：5小时30分钟"` 这类带前缀的写法被判空。
  const cases = [
    ["总计：5小时30分钟", "5h 30m"],
    ["2026-10-05 5小时0分钟", "5h"],
    ["编号A-12 5小时", "5h"],
    ["5小时30分钟额外文字", "5h 30m"],
    ["+5小时", "5h"],
  ];
  for (const [readTime, note] of cases) {
    const s = buildReadingStats({ totalReadTime: 600 }, { preferAuthor: [{ name: "X", readTime }] });
    assert.equal(s.authorClouds[0]?.words[0]?.note, note, `${readTime} 应解析为 ${note}`);
  }
  // 减号族的完整覆盖：全部整条拒（含 U+2043 与 U+2796 这类既不属于 Pd
  // 也不属于 Sm 的符号）。
  // 注意 U+30FC（片假名长音符）**不在**此列：它属于字母，日语里「ー」后跟数字完全合法，
  // 把它当负号会把正常的日文时长串判空（独立评审的清单一度把它列进来，实测复现后剔除）。
  const dashes = [
    "\u002d", "\u2212", "\u2013", "\u2014", "\u2012", "\u2015", "\u2010", "\u2011",
    "\uff0d", "\ufe63", "\ufe58", "\u02d7", "\u2043", "\u2796", "\u2216", "\u208b",
  ];
  for (const d of dashes) {
    const readTime = `${d}5小时`;
    const s = buildReadingStats({ totalReadTime: 600 }, { preferAuthor: [{ name: "X", readTime }] });
    assert.deepEqual(
      s.authorClouds[0]?.words ?? [],
      [],
      `${JSON.stringify(readTime)} 是负时长，应被拒`,
    );
  }
});

test("超出合理量级的秒数被拒，不会出现 277777h 这种 note", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [
      { name: "天文数字", readTime: 1e9 },
      { name: "正常", readTime: 7200 },
    ],
  });
  assert.deepEqual(s.authorClouds[0].words.map((w) => w.name), ["正常"]);
});

test("同名去重折叠大小写（MUJI 与 muji 是同一家）", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferPublisher: [
      { name: "MUJI", count: 5 },
      { name: "muji", count: 8 },
    ],
  });
  assert.equal(s.publisherClouds[0].words.length, 1, "大小写不同不该算两家");
  assert.equal(s.publisherClouds[0].words[0].note, "8 本", "应取两者中较大的权重");
});

test("缺名、零权重、非法条目一律跳过，不抛异常", () => {
  const s = buildReadingStats({ totalReadTime: 600 }, {
    preferAuthor: [null, 42, {}, { name: 123 }, { name: "零", readTime: "0小时0分钟" }, { name: "  " }],
    preferPublisher: "不是数组",
    preferCp: [null, { count: 3 }, { copyrightInfo: { name: 7 } }, { count: 0, copyrightInfo: { name: "零本社" } }],
    readLongest: [{ book: "不是对象", readTime: 100 }, { book: { author: "无时长" } }],
    preferCategory: [{ categoryTitle: "零时长", readingTime: 0 }],
  });
  assert.deepEqual(s.authorClouds, []);
  assert.deepEqual(s.publisherClouds, []);
});

test("累计周期缺失或为空时两张卡都不占位", () => {
  for (const overall of [null, {}, { preferAuthor: [], preferPublisher: [], readLongest: [], preferCategory: [] }]) {
    const s = buildReadingStats({ totalReadTime: 600 }, overall);
    assert.deepEqual(s.authorClouds, []);
    assert.deepEqual(s.publisherClouds, []);
  }
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

// ---------------------------------------------------------------------------
// 云图排布：圆形散开、互不压住、不横向出界
// ---------------------------------------------------------------------------

/** 与组件一致的可用区：168 × 148 的卡减去 1px 边框与 20px 内边距 */
const CLOUD_W = 126;
const CLOUD_H = 106;

/** 用真实回包里的名字构造词表（估宽用的字符类别与线上一致） */
const words = (...names) =>
  names.map((name, i) => ({ name, note: `${names.length - i}`, weight: 100 - i * 10 }));

/**
 * 断言两两不重叠。
 *
 * 容差用于容纳「盒宽含 4px 缓冲、而字形比盒窄」带来的擦边：现网三屏实测
 * 横向相交词对的最大纵向重叠是 -3.95px（即根本不交叠），所以现网数据下容差用不到。
 * 只有物理上塞不下的输入（例如 5 个同长中文词）才会用到一点容差；
 * 那类输入现在已被 MAX_WORDS_PER_CLOUD 挡在布局外。
 */
function assertNoOverlap(placements, tolerance = 2) {
  for (let a = 0; a < placements.length; a++) {
    for (let b = a + 1; b < placements.length; b++) {
      const A = placements[a];
      const B = placements[b];
      const boxW = (p) => estimateWordWidth(p.name, p.fontSize) + 4;
      const boxH = (p) => p.fontSize * 1.25 + 2;
      const overlapX = Math.min(A.x + boxW(A), B.x + boxW(B)) - Math.max(A.x, B.x);
      const overlapY = Math.min(A.y + boxH(A), B.y + boxH(B)) - Math.max(A.y, B.y);
      assert.ok(
        overlapX <= 0 || overlapY <= tolerance,
        `${A.name} 与 ${B.name} 压住了（重叠 ${overlapX.toFixed(1)}×${overlapY.toFixed(1)}px，超过 ${tolerance}px 容差）`,
      );
    }
  }
}

test("作者屏：四个词圆形散开，互不重叠、不横向出界", () => {
  const out = layoutCloud(
    words("尤瓦尔·赫拉利", "杨堃", "苏杰", "吴晓波"),
    CLOUD_W,
    CLOUD_H,
  );
  assert.equal(out.length, 4);
  assertNoOverlap(out);
  for (const p of out) {
    assert.ok(p.x >= 0, `${p.name} 跑到左边界之外`);
    assert.ok(
      p.x + estimateWordWidth(p.name, p.fontSize) + 4 <= CLOUD_W + 0.5,
      `${p.name} 超出右边界`,
    );
    assert.ok(p.y >= 0 && p.y + p.fontSize * 1.25 <= CLOUD_H, `${p.name} 超出上下边界`);
  }
  // 首名字号最大，且落在画布中心附近（云图的视觉重心）
  assert.equal(out[0].fontSize, 15);
  // 注意：整团居中保证的是「词团包围盒」居中对齐，不保证首名自己的中心落在画布中心
  // （四词时首名中心实测会偏 3~13px）；居中的有效性由「整团居中」那条用例守着。
});

test("出版社屏：三个长名字互不压住，且用满内容盒的纵向空间", () => {
  // 说明：126px 宽的内容盒里，三个出版社名的词盒各宽 81~95px，
  // 两个名字并排需要 190px 以上，物理上做不到 —— 因此这一屏只要求
  // 「不压住 + 纵向铺开 + 首名居中」，不要求横向跨度（实测 30px 已是这块画布的上限）。
  const out = layoutCloud(
    words("中信出版集团", "电子工业出版社", "机械工业出版社"),
    CLOUD_W,
    CLOUD_H,
  );
  assert.equal(out.length, 3);
  assertNoOverlap(out);
  const ys = out.map((p) => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 25, "三个词挤在同一水平线上");
  // 注意：整团居中保证的是「词团包围盒」居中对齐，不保证首名自己的中心落在画布中心
  // （四词时首名中心实测会偏 3~13px）；居中的有效性由「整团居中」那条用例守着。
});

test("分类屏：短词同样散得开且不压住", () => {
  const out = layoutCloud(
    words("经济理财", "文学", "历史", "计算机"),
    CLOUD_W,
    CLOUD_H,
  );
  assertNoOverlap(out);
  assert.equal(new Set(out.map((p) => `${p.x},${p.y}`)).size, out.length, "有词落在同一位置");
});

test("字号按名次递减，颜色全部是绿色深浅（不出现灰阶）", () => {
  const out = layoutCloud(words("甲", "乙", "丙", "丁"), CLOUD_W, CLOUD_H);
  assert.deepEqual(out.map((p) => p.fontSize), [15, 14, 12, 11]);
  assert.equal(out[0].bold, true, "首名应加粗");
  assert.equal(out[3].bold, false);
  // 绿色档位由浅入深：首名 1，越靠后档位数字越大，组件按档位取实体色，没有灰阶分支
  const shades = out.map((p) => p.shade);
  assert.deepEqual(shades, [1, 2, 3, 3]);
});

test("云图三档色值：最深档等于热力图绿，其余依次变淡", () => {
  /*
   * 口径：色值取自阅读组件 SHADE_CLASS 的精确 RGB 任意值，底色取卡片实测合成色
   * （亮 rgb(255,255,255)、暗 rgb(82,82,85)），与「热力图绿」比较时同样按实测像素。
   * 用户指定最深一档取热力图的绿（CalendarHeatmap 的 bg-emerald-300/70），
   * 其余档位在它基础上依次提亮（亮底与暗底上「淡」都等于更亮）。
   */
  const light = [
    [142, 240, 203],
    [159, 242, 211],
    [176, 244, 218],
  ];
  const dark = [
    [41, 147, 115],
    [77, 166, 133],
    [110, 184, 150],
  ];
  const HEATMAP_LIGHT = [142, 240, 203]; // 实测：bg-emerald-300/70 合成到白底
  const HEATMAP_DARK = [41, 147, 115]; // 实测：dark:bg-emerald-400/50 合成到暗色卡底
  const lum = (rgb) => {
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  };

  assert.deepEqual(light[0], HEATMAP_LIGHT, "亮色最深档必须等于热力图绿");
  assert.deepEqual(dark[0], HEATMAP_DARK, "暗色最深档必须等于热力图绿");

  // 同一主题内亮度单调递增（依次变淡）
  for (const [name, shades] of [["亮色", light], ["暗色", dark]]) {
    for (let i = 1; i < shades.length; i++) {
      assert.ok(
        lum(shades[i]) > lum(shades[i - 1]),
        `${name}第 ${i + 1} 档没有比第 ${i} 档更淡（亮度未递增）`,
      );
    }
  }

  /*
   * 记录已知代价而不假装达标：这个基准色是 pastel 色，亮色下三档对比度
   * 都在 1.2~1.4:1，低于 WCAG 正文 4.5:1 与大字的 3:1。
   * 这里把上限钉住，避免以后有人以为它达标；真要达标必须同时加深热力图的绿。
   */
  const ratio = (fg, bg) => {
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };
  const white = [255, 255, 255];
  const lightRatios = light.map((c) => ratio(c, white));
  assert.ok(
    lightRatios.every((r) => r < 1.5),
    `亮色三档对比度 ${lightRatios.map((r) => r.toFixed(2)).join("/")} 超出预期，口径变了要同步 README`,
  );
  // 暗色三档在暗底上都还能辨认（≥2:1），这是与热力图一致的前提下能拿到的最好结果
  const darkCard = [82, 82, 85];
  for (const [i, c] of dark.entries()) {
    assert.ok(ratio(c, darkCard) >= 2, `暗色第 ${i + 1} 档对比度不足 2:1`);
  }
});

test("真实回包的三张云图逐屏扫描：无重叠、无越界、居中", () => {
  // 与线上同一条数据路径：真实网关回包 → buildReadingStats → layoutCloud。
  // 现网词数（作者/分类 4、出版社 3）在 126 × 106 内容盒下必须完全干净。
  const monthly = JSON.parse(readFileSync(new URL("./fixtures/weread-monthly.json", import.meta.url), "utf8"));
  const overall = JSON.parse(readFileSync(new URL("./fixtures/weread-overall.json", import.meta.url), "utf8"));
  const stats = buildReadingStats(monthly, overall);
  assert.ok(stats, "真实回包应能构建出统计对象");
  const clouds = [...stats.authorClouds, ...stats.publisherClouds];
  assert.equal(clouds.length, 3, "现网应为作者 2 屏 + 出版社 1 屏");
  for (const cloud of clouds) {
    const out = layoutCloud(cloud.words, CLOUD_W, CLOUD_H);
    assert.equal(out.length, cloud.words.length, `${cloud.label} 有词丢失`);
    assertNoOverlap(out, 0);
    for (const p of out) {
      const w = estimateWordWidth(p.name, p.fontSize) + 4;
      assert.ok(p.x >= -0.6 && p.x + w <= CLOUD_W + 0.6, `${cloud.label} 的 ${p.name} 横向越界`);
      assert.ok(
        p.y >= -0.6 && p.y + p.fontSize * 1.25 <= CLOUD_H + 0.6,
        `${cloud.label} 的 ${p.name} 纵向越界`,
      );
    }
  }
});

test("同一份数据每次排布完全一致（缓存与 SSR 不会抖）", () => {
  const w = words("尤瓦尔·赫拉利", "杨堃", "苏杰", "吴晓波");
  assert.deepEqual(layoutCloud(w, CLOUD_W, CLOUD_H), layoutCloud(w, CLOUD_W, CLOUD_H));
});

test("装不下的长词降字号，不出现越界坐标或被裁掉半截", () => {
  // 回归用例：曾出现「8 字词 @15px = 130px > 画布 126px」时 clampX 把 x 夹到左边界、
  // 右半截露在画布外被 overflow:hidden 裁掉；长词还会因负宽度落到同一点。
  const long = Array.from({ length: 4 }, (_, i) => ({
    name: "长".repeat(11 - (i % 3)),
    note: "",
    weight: 100 - i * 10,
  }));
  const out = layoutCloud(long, CLOUD_W, CLOUD_H);
  assert.equal(out.length, 4);
  for (const p of out) {
    const boxW = estimateWordWidth(p.name, p.fontSize) + 4;
    assert.ok(
      p.x >= -0.6 && p.x + boxW <= CLOUD_W + 0.6,
      `${p.name} 横向越界：x=${p.x} 盒宽=${boxW} 画布=${CLOUD_W}`,
    );
    assert.ok(
      Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.fontSize),
      `${p.name} 产出非有限数值`,
    );
  }
  assert.equal(
    new Set(out.map((p) => `${p.x},${p.y}`)).size,
    out.length,
    "有词落到同一个点上",
  );
});

test("每屏词数上限是布局层的硬约束，超出的直接丢弃", () => {
  // 这是几何约束：126 × 106 放不下 5 个同长中文词（实测残留 2 对约 2.7px 盒重叠）。
  // 上游取词数已限到 3~4，这里兜一层，防止有人调大上限后云图悄悄压字。
  const many = Array.from({ length: 9 }, (_, i) => ({
    name: `词${i}${"长".repeat(i % 3)}`,
    note: "",
    weight: 100 - i * 5,
  }));
  const out = layoutCloud(many, CLOUD_W, CLOUD_H);
  assert.equal(out.length, 4, "超过 4 个应被截断");
  assert.equal(out[0].name, many[0].name, "保留的是权重最高的前 4 个");
  assertNoOverlap(out, 0);

  // 乱序入参：取「权重最高的 4 个」而不是「输入顺序的前 4 个」。
  // 回归用例：早先是 input.slice(0, 4)，权重 [1,999,50,5,5000] 会丢掉最重的 5000。
  const messy = [
    { name: "轻", note: "", weight: 1 },
    { name: "最重", note: "", weight: 5000 },
    { name: "中", note: "", weight: 50 },
    { name: "小", note: "", weight: 5 },
    { name: "重", note: "", weight: 999 },
  ];
  const kept = layoutCloud(messy, CLOUD_W, CLOUD_H).map((p) => p.name);
  assert.equal(kept.length, 4);
  assert.deepEqual(kept, ["最重", "重", "中", "小"], "应按权重取前 4，而不是按入参顺序");
});

test("硬分离必须真的把轻词让开（变异守卫：退回旧实现本条会红）", () => {
  // 独立评审做过变异：把硬分离的分支换回旧版「只沿横向推」时，全套测试仍然全绿 ——
  // 也就是说那处修复此前无人守。这里用能在现网画布上区分两版的输入：
  // n=4、词长 4 时旧版残留 1 对约 2.8×1.7px 盒重叠，新版 0 对。
  const cases = [
    ["一二三四", "一二三四", "一二三四", "一二三四"],
    ["甲乙丙丁", "戊己庚辛", "壬癸子丑", "寅卯辰巳"],
    ["中信出版集团", "电子工业出版社", "机械工业出版社", "人民邮电出版社"],
  ];
  for (const names of cases) {
    const out = layoutCloud(
      names.map((name, i) => ({ name, note: "", weight: 100 - i * 10 })),
      CLOUD_W,
      CLOUD_H,
    );
    assertNoOverlap(out, 0);
    // 同时必须都还在画布内：硬分离不能靠把词推出画布来「消除重叠」
    for (const p of out) {
      const w = estimateWordWidth(p.name, p.fontSize) + 4;
      assert.ok(p.x >= -0.6 && p.x + w <= CLOUD_W + 0.6, `${p.name} 横向越界`);
      assert.ok(p.y >= -0.6 && p.y + p.fontSize * 1.25 <= CLOUD_H + 0.6, `${p.name} 纵向越界`);
    }
  }
});

test("11 字长名压到最小字号后仍能整条落在画布内", () => {
  const out = layoutCloud(
    [{ name: "江苏凤凰科学技术出版社", note: "", weight: 100 }],
    CLOUD_W,
    CLOUD_H,
  );
  const p = out[0];
  const boxW = estimateWordWidth(p.name, p.fontSize) + 4;
  assert.ok(p.x >= -0.6 && p.x + boxW <= CLOUD_W + 0.6, "长名横向越界");
  assert.ok(p.fontSize >= 9, `字号被压到 ${p.fontSize}px，太小`);
});

test("整团居中：词团包围盒的中心落在画布中心附近", () => {
  // 变异测试发现这条此前无人兜：把 layoutCloud 里的「整团居中」整段删掉，
  // 其余断言全绿（因为那个用例的词团本来就接近居中）。这里显式钉住居中效果。
  const cases = [
    words("尤瓦尔·赫拉利", "杨堃", "苏杰", "吴晓波"),
    words("经济理财", "文学", "历史", "计算机"),
    words("中信出版集团", "电子工业出版社", "机械工业出版社"),
    words("甲", "乙", "丙", "丁"),
  ];
  for (const ws of cases) {
    const out = layoutCloud(ws, CLOUD_W, CLOUD_H);
    const minX = Math.min(...out.map((p) => p.x));
    const maxX = Math.max(...out.map((p) => p.x + estimateWordWidth(p.name, p.fontSize) + 4));
    const minY = Math.min(...out.map((p) => p.y));
    const maxY = Math.max(...out.map((p) => p.y + p.fontSize * 1.25 + 2));
    const offX = Math.abs((minX + maxX) / 2 - CLOUD_W / 2);
    const offY = Math.abs((minY + maxY) / 2 - CLOUD_H / 2);
    // 词团比画布宽时会在横向上被边界夹住，纵向上同理，两种情形都不该超过 2px 偏差
    assert.ok(
      offX <= 2 && offY <= 2,
      `${ws.map((w) => w.name).join("/")} 词团中心偏移 x=${offX.toFixed(2)} y=${offY.toFixed(2)}`,
    );
  }
});

test("空词表返回空数组；单个词也不抛异常", () => {
  assert.deepEqual(layoutCloud([], CLOUD_W, CLOUD_H), []);
  const one = layoutCloud(words("独苗"), CLOUD_W, CLOUD_H);
  assert.equal(one.length, 1);
  assert.equal(one[0].fontSize, 15);
});
