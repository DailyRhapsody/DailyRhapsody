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
  layoutCloud,
  estimateWordWidth,
} from "../lib/reading-cloud-layout.ts";
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
// 云图轮播：作者三屏（preferAuthor / readLongest / preferCategory）
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

function assertNoOverlap(placements) {
  for (let a = 0; a < placements.length; a++) {
    for (let b = a + 1; b < placements.length; b++) {
      const A = placements[a];
      const B = placements[b];
      // 盒高 = 字号 × 1.25 + 2；盒宽按同样的估宽公式重算，留 4px 余量
      const boxW = (p) => estimateWordWidth(p.name, p.fontSize) + 4;
      const boxH = (p) => p.fontSize * 1.25 + 2;
      const overlapX = Math.min(A.x + boxW(A), B.x + boxW(B)) - Math.max(A.x, B.x);
      const overlapY = Math.min(A.y + boxH(A), B.y + boxH(B)) - Math.max(A.y, B.y);
      assert.ok(
        overlapX <= 0 || overlapY <= 0,
        `${A.name} 与 ${B.name} 压住了（重叠 ${overlapX.toFixed(1)}×${overlapY.toFixed(1)}px）`,
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
  assert.ok(Math.abs(out[0].x + 40 - CLOUD_W / 2) < 40, "首名没有落在中心附近");
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
  assert.ok(Math.abs(out[0].x + 47 - CLOUD_W / 2) < 25, "首名没有居中");
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
  // alpha 递减且都在 (0, 1]，组件据此做 color-mix，没有灰阶分支
  const alphas = out.map((p) => p.alpha);
  assert.deepEqual(alphas, [...alphas].sort((a, b) => b - a));
  assert.ok(alphas.every((a) => a > 0 && a <= 1));
});

test("同一份数据每次排布完全一致（缓存与 SSR 不会抖）", () => {
  const w = words("尤瓦尔·赫拉利", "杨堃", "苏杰", "吴晓波");
  assert.deepEqual(layoutCloud(w, CLOUD_W, CLOUD_H), layoutCloud(w, CLOUD_W, CLOUD_H));
});

test("装不下的长词降字号，不出现越界坐标或被裁掉半截", () => {
  // 回归用例：曾出现「8 字词 @15px = 130px > 画布 126px」时 clampX 把 x 夹到左边界、
  // 右半截露在画布外被 overflow:hidden 裁掉；5 个长词时还会因负宽度落到同一点。
  const long = Array.from({ length: 5 }, (_, i) => ({
    name: "长".repeat(11 - (i % 3)),
    note: "",
    weight: 100 - i * 10,
  }));
  const out = layoutCloud(long, CLOUD_W, CLOUD_H);
  assert.equal(out.length, 5);
  for (const p of out) {
    const boxW = estimateWordWidth(p.name, p.fontSize) + 4;
    assert.ok(
      p.x >= -0.6 && p.x + boxW <= CLOUD_W + 0.6,
      `${p.name} 横向越界：x=${p.x} 盒宽=${boxW} 画布=${CLOUD_W}`,
    );
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${p.name} 坐标不是有限数`);
  }
  assert.equal(
    new Set(out.map((p) => `${p.x},${p.y}`)).size,
    out.length,
    "有词落到同一个点上",
  );
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

test("空词表返回空数组；单个词也不抛异常", () => {
  assert.deepEqual(layoutCloud([], CLOUD_W, CLOUD_H), []);
  const one = layoutCloud(words("独苗"), CLOUD_W, CLOUD_H);
  assert.equal(one.length, 1);
  assert.equal(one[0].fontSize, 15);
});
