/**
 * 微信读书阅读数据。
 *
 * 取数走服务端单向：Cron 拉一次官方网关写入 Redis，页面服务端只读缓存，
 * 不把 API Key 带进浏览器，也不在每次浏览时打第三方接口。
 *
 * 接口协议以腾讯官方 skill 文档为准
 * （github.com/Tencent/WeChatReading/skills，readdata.md 与 SKILL.md，v1.0.5）：
 *   POST https://i.weread.qq.com/api/agent/gateway
 *   Authorization: Bearer wrk-xxxx
 *   body: {"api_name": "/readdata/detail", "mode": "monthly", "skill_version": "1.0.5"}
 * 业务参数平铺在 body 顶层，不要包进 params。
 *
 * 两处与直觉相反的字段，容易写错，已按文档口径处理：
 * 1. totalReadTime 单位是秒（不是分钟）。
 * 2. readTimes 的 key 是分桶起始**时间戳（秒）**，不是日期字符串；monthly 按天分桶，
 *    且只返回有阅读记录的那些天，缺日必须自行补 0，否则曲线出现断口。
 *
 * 降级要求：缺少 API Key 或 Redis 时不得抛异常；失败路径只读不写，
 * 避免一次失败抹掉可用数据。
 */

export type ReadingBook = {
  title: string;
  minutes: number;
  /** 有声内容条目走 albumInfo，只读 book.title 会渲染空白 */
  album?: boolean;
};

/** 偏好行，label 是「分类／作者／出版社」这类中文标签 */
export type ReadingPreference = { label: string; value: string };

/**
 * 词云里的一个词。weight 是**归一化到 0~100 的相对权重**，不是原始数值：
 * 作者用阅读秒数、出版社用书籍本数，两者量级差好几个数量级
 * （作者 168300 秒 vs 出版社 32 本），原样交给卡片会让字号映射无法共用一套算法。
 * 归一化在**每张云图内部**做，因此同一张卡里各屏的字号都可以直接比。
 */
export type ReadingCloudWord = {
  name: string;
  weight: number;
  /** 原始口径的可读文案，如作者的「46h 50m」、出版社的「32 本」 */
  note: string;
};

/**
 * 一张云图，对应轮播卡里的一屏。
 *
 * 屏内不再有「分类／作者／出版社」这类字段名：字段名是接口的组织方式，
 * 不是读者要看的信息，画面让给词本身。口径说明只进 aria-label 与悬停提示。
 */
export type ReadingCloud = {
  /** 无障碍与悬停用的口径说明，如「作者 · 按累计阅读时长」，不显示在卡面上 */
  label: string;
  words: ReadingCloudWord[];
};

export type ReadingStats = {
  /** 展示用的月份标识，形如 2026-10 */
  month: string;
  /** 本月总时长（分钟） */
  monthMinutes: number;
  /** 本月有阅读记录的天数 */
  monthDays: number;
  /** 本月逐日分钟数，只到「已过去的天数」为止 */
  daily: number[];
  /** 本月读得最多的书或听书。接口按 5 分钟下限过滤，当月读得少时可能只有一条 */
  books: ReadingBook[];
  /** 本月统计摘要，如「读过 1 本 · 阅读 4 天」，取自 readStat；书目少时用它填满该屏 */
  summary: string;
  /** 累计偏好，取自 overall 周期，每类第 1 名 */
  preferences: ReadingPreference[];
  /**
   * 作者类云图，按屏排列。当前两屏，每屏一个口径：
   * 1. preferAuthor 前 AUTHOR_CLOUD_MAX_WORDS 条，按累计阅读时长加权
   * 2. preferCategory 前 AUTHOR_CLOUD_MAX_WORDS 条（读的是什么类型），按累计阅读时长加权
   * 曾经的「readLongest 每本书的作者」一屏已删除：与 preferAuthor 高度重合。
   * 每屏各自归一到 0~100，因此同一张卡里各屏的字号都可以直接比。
   */
  authorClouds: ReadingCloud[];
  /**
   * 出版社类云图，一屏，取前 CLOUD_MAX_WORDS 家：
   * preferPublisher（10 条）∪ preferCp（10 条），同名取较大 count，按本数加权。
   * 条目里没有 readTime —— 接口不提供按社时长，只能按本数。
   * 曾经把第 7 名之后拆成第二、第三屏，已删除：一屏足够说明谁占主导。
   */
  publisherClouds: ReadingCloud[];
  /**
   * 累计阅读时段：24 个点的秒数。下标 0 对应 6 时，末位对应次日 5 时，
   * 与接口口径一致 —— 这个起点顺序容易误判成 0 时开始，卡片上必须标出来。
   */
  hourly: number[];
  /** 接口给的时段文案，如「偏好夜间阅读」 */
  hourlyWord: string;
  refreshedAt: number;
};

// v8：字段名屏换成作者／出版社两张**云图轮播**卡，ReadingStats 的
// authorCloud / publisherCloud 变成按屏排列的 authorClouds / publisherClouds。
// 与 Notion 侧同一约定：回包结构一变就推进版本号，否则旧结构会留在缓存里 ——
// 新字段读不到、卡片少一屏，而且看起来像接口没返回数据。
const CACHE_KEY = "dr:weread:monthly:v8";
/** 与 Notion 侧同策略：硬 TTL 48h，对每日一次的 Cron 留出一整天余量 */
const CACHE_HARD_TTL_S = 48 * 60 * 60;
/** 独立超时预算。Cron 共享 300s 预算，微信读书失败可读上一份缓存，是最适合牺牲的一段 */
const GATEWAY_TIMEOUT_MS = Number(process.env.WEREAD_TIMEOUT_MS) || 10_000;
/** 页面回源填充的预算，比 Cron 更短，避免渲染被第三方接口拖住 */
const PAGEVIEW_FILL_TIMEOUT_MS = Number(process.env.WEREAD_FILL_TIMEOUT_MS) || 2_000;
const GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
/** 官方要求在每次请求的 body 里上报技能版本，服务端据此检查更新 */
const SKILL_VERSION = "1.0.5";
/** 与 lib/notion-diary-date.ts 的 Asia/Shanghai 口径一致，避免跨月边界差一天 */
const TIME_ZONE = "Asia/Shanghai";

let _redis: import("@upstash/redis").Redis | null | undefined;

async function getRedis() {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) {
    const { Redis } = await import("@upstash/redis");
    _redis = new Redis({ url, token });
  } else {
    _redis = null;
  }
  return _redis;
}

function apiKey(): string | null {
  return process.env.WEREAD_API_KEY?.trim() || null;
}

/** 统一入口。每次调用都必须带 skill_version */
async function callGateway(
  apiName: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ api_name: apiName, ...params, skill_version: SKILL_VERSION }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[weread] ${apiName} 网关返回 ${res.status}`);
      return null;
    }
    const payload = (await res.json()) as Record<string, unknown>;
    if (payload.errcode && payload.errcode !== 0) {
      console.warn(`[weread] ${apiName} errcode=${payload.errcode} ${payload.errmsg ?? ""}`);
      return null;
    }
    // 官方硬要求：出现 upgrade_info 必须停下按指引升级，不得忽略
    if (payload.upgrade_info) {
      console.warn(
        `[weread] 官方要求升级后再调用：${JSON.stringify(payload.upgrade_info).slice(0, 300)}`,
      );
      return null;
    }
    return payload;
  } catch (e) {
    console.warn(`[weread] ${apiName} 调用失败:`, e);
    return null;
  }
}

/** 秒 → 分钟 */
function toMinutes(seconds: unknown): number | null {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n / 60);
}

/** 形如「5小时30分钟」「21小时45分钟」的格式化字符串，preferAuthor[].readTime 就是这种 */
function parseFormattedDuration(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const h = /(\d+(?:\.\d+)?)\s*(?:小时|h)/i.exec(text);
  const m = /(\d+)\s*(?:分钟|分|min)/i.exec(text);
  if (!h && !m) return null;
  return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
}

/**
 * 上海时区下「今天」的日序号与当月天数。
 * 只画到已过去的天数，避免未来的日子被补成 0 而让曲线看着像断崖。
 */
function shanghaiMonthProgress(): { month: string; elapsedDays: number; daysInMonth: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(new Date()).split("-").map(Number);
  const month = `${y}-${String(m).padStart(2, "0")}`;
  return { month, elapsedDays: d, daysInMonth: new Date(y, m, 0).getDate() };
}

/**
 * 把 readTimes 规整成「1 日起、长度等于已过天数、缺日补 0」的分钟数组。
 * key 是分桶起始时间戳（秒），文档口径；同时兼容 YYYY-MM-DD 与 YYYYMMDD，
 * 便于以后换周期或字段时不必重写。
 * 导出供 tests/weread-stats.test.mjs 直接校验。
 */
export function normalizeDaily(
  raw: unknown,
  month: string,
  elapsedDays: number,
): number[] {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const length = Math.max(1, Math.min(elapsedDays, daysInMonth));
  const out = new Array<number>(length).fill(0);
  if (!raw || typeof raw !== "object") return out;

  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((v, i) => [String(i), v])
    : Object.entries(raw as Record<string, unknown>);

  for (const [key, value] of entries) {
    let day: number | null = null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(key);
    if (iso) day = Number(iso[3]);
    else if (compact) day = Number(compact[3]);
    else if (/^\d{10}$/.test(key)) day = new Date(Number(key) * 1000).getDate();
    else if (/^\d{13}$/.test(key)) day = new Date(Number(key)).getDate();
    if (day === null || day < 1 || day > length) continue;

    const minutes =
      typeof value === "number"
        ? toMinutes(value)
        : toMinutes((value as { readTime?: unknown } | null)?.readTime);
    if (minutes !== null) out[day - 1] = minutes;
  }
  return out;
}

/**
 * 读得最多的书或听书。条目走 book.title，有声内容走 albumInfo。
 * 这里不设条数上限：接口本身最多给 10 条，展示多少由卡片按可用高度决定。
 */
function parseBooks(raw: unknown): ReadingBook[] {
  if (!Array.isArray(raw)) return [];
  const out: ReadingBook[] = [];
  for (const item of raw) {
    const it = item as Record<string, unknown>;
    const book = it.book as Record<string, unknown> | undefined;
    const album = it.albumInfo as Record<string, unknown> | undefined;
    const title =
      (typeof book?.title === "string" && book.title) ||
      (typeof album?.name === "string" && album.name) ||
      (typeof album?.title === "string" && album.title) ||
      "";
    if (!title) continue;
    const minutes =
      toMinutes(it.readTime) ?? parseFormattedDuration(it.readTime) ?? 0;
    out.push({ title, minutes, album: Boolean(album) });
  }
  return out;
}

/**
 * 本月统计摘要。monthly 的 readStat 是 [{stat:'读过',counts:'1本'}, ...]，
 * 拼成一行短句；书目只有一两条时用它把第二屏填满。
 */
function parseSummary(monthly: Record<string, unknown>): string {
  const items = Array.isArray(monthly.readStat) ? monthly.readStat : [];
  return items
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((x) => [x.stat, x.counts] as const)
    .filter(([stat, counts]) => typeof stat === "string" && typeof counts === "string")
    // 「读完 0 本」「笔记 0 条」这类零值不展示，避免摘要里全是 0
    .filter(([, counts]) => !/^0\D/.test(counts as string))
    .map(([stat, counts]) => `${stat} ${counts}`)
    .join(" · ");
}

/**
 * 累计偏好三行。三行都取 overall 周期：
 * monthly 的 preferAuthor 与 preferPublisher 有展示阈值，当月读得少时整个字段不返回，
 * 卡片会出现只有分类一行的空感。
 */
function parsePreferences(overall: Record<string, unknown> | null): ReadingPreference[] {
  if (!overall) return [];
  const rows: ReadingPreference[] = [];

  /** 回包里的数组可能夹带 null 或非对象，先过滤再排序，否则 sort 里读字段会抛 */
  const asObjects = (raw: unknown): Record<string, unknown>[] =>
    (Array.isArray(raw) ? raw : []).filter(
      (x): x is Record<string, unknown> =>
        typeof x === "object" && x !== null && !Array.isArray(x),
    );
  // 服务端会补默认分类占位，readingTime 为 0 的必须过滤，否则会显示「读过 0 秒的偏好」
  /** 取该类权重最高的名称。168px 卡宽扣掉标签列只够一个名字，放两个会被截断 */
  const topName = (items: Record<string, unknown>[], by: string, field: string): string => {
    const best = [...items].sort(
      (a, b) => (Number(b[by]) || 0) - (Number(a[by]) || 0),
    )[0];
    const v = best?.[field];
    return typeof v === "string" ? v : "";
  };

  // 服务端会补默认分类占位，readingTime 为 0 的必须过滤，否则会显示「读过 0 秒的偏好」
  const category = topName(
    asObjects(overall.preferCategory).filter((c) => Number(c.readingTime) > 0),
    "readingTime",
    "categoryTitle",
  );
  if (category) rows.push({ label: "分类", value: category });

  const author = topName(asObjects(overall.preferAuthor), "count", "name");
  if (author) rows.push({ label: "作者", value: author });

  const publisher = topName(asObjects(overall.preferPublisher), "count", "name");
  if (publisher) rows.push({ label: "出版社", value: publisher });

  return rows;
}

/**
 * 每屏云图最多几个词。云图屏在卡片的内容盒里（168 × 148 的卡减去 1px 边框与
 * 20px 内边距，只有 126 × 106），词要在里面**圆形散开且互不压住**。
 * 126px 宽放不下两个长词（出版社名 6~8 字，13px 就要 90~110px），
 * 所以每屏只能取前几名：出版社 3、作者与分类 4。再多就得压到 9px 以下，
 * 或者排成互相贴住的竖列 —— 两条路都渲染出来看过，都不像云图。
 */
const CLOUD_MAX_WORDS = 3;
/** 作者名与分类名短（2~6 字），同样面积能多放一个 */
const AUTHOR_CLOUD_MAX_WORDS = 4;

/**
 * 作者累计阅读时长的秒数。
 *
 * preferAuthor[].readTime 实测是「21小时45分钟」这类**格式化字符串**，不是秒数，
 * 与 totalReadTime 的单位口径相反，先按字符串解析；真拿到纯数字时按秒处理，
 * 免得哪天服务端改成数值口径后又把 168300 秒读成 168300 分钟。
 */
function preferenceSeconds(value: unknown): number | null {
  const formatted = parseFormattedDuration(value);
  if (formatted !== null) return formatted * 60;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** 秒 → 「46h 50m」；不足 1 小时只写分钟，避免出现「0h 35m」 */
function formatSecondsAsHours(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** 去重排序后但尚未归一化的词 */
type RawCloudWord = { name: string; weight: number; note: string };

/**
 * 把 [{name, ...}] 这类数组整成排好序、去过重的词表，
 * 同名取较大权重：接口偶尔会因译者、再版分成两条同名记录，
 * 直接铺开会出现两个字号不同的「苏杰」。
 * 这里不做归一化 —— 归一化是按**每张云图**做的，得等分屏切完再算。
 */
function collectWords(
  items: unknown,
  readName: (item: Record<string, unknown>) => string,
  weightOf: (item: Record<string, unknown>) => number | null,
  noteOf: (item: Record<string, unknown>, weight: number) => string,
): RawCloudWord[] {
  const byName = new Map<string, RawCloudWord>();
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const it = item as Record<string, unknown>;
    const name = readName(it);
    if (!name) continue;
    const weight = weightOf(it);
    if (weight === null || weight <= 0) continue;
    const prev = byName.get(name);
    if (!prev || weight > prev.weight) {
      byName.set(name, { name, weight, note: noteOf(it, weight) });
    }
  }
  // 权重并列时按名称定序，保证同一天两次 Cron 拉到的顺序一致，缓存内容不抖
  return [...byName.values()].sort(
    (a, b) => b.weight - a.weight || a.name.localeCompare(b.name, "zh-Hans-CN"),
  );
}

/** 每个词按本屏最大值归一到 0~100，同一张卡里各屏字号因此可比 */
function normalizeCloud(words: RawCloudWord[]): ReadingCloudWord[] {
  if (words.length === 0) return [];
  const max = words[0].weight;
  return words.map((w) => ({
    name: w.name,
    weight: Math.round((w.weight / max) * 1000) / 10,
    note: w.note,
  }));
}

/** 取一个对象的字符串字段；空串与纯空白都算没有 */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 取 {name, ...} 或 {copyrightInfo: {name}} 两种形态里的名字 */
function itemName(it: Record<string, unknown>): string {
  const direct = str(it.name);
  if (direct) return direct;
  const nested = it.copyrightInfo;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return str((nested as Record<string, unknown>).name);
  }
  return "";
}

/** 本数权重：count 是「读过几本」，正数才算 */
function countWeight(it: Record<string, unknown>): number | null {
  const n = Number(it.count);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 作者云图，按屏排列。两屏口径互不相同，都是接口直接给的词组：
 *   第 1 屏 preferAuthor   —— 作者维度的偏爱，按累计阅读时长加权
 *   第 2 屏 preferCategory —— 读的是什么类型，按累计阅读时长加权
 * 空屏直接不出现，因此当月数据缺失时会少一屏而不是出现空白卡。
 *
 * 曾经的「readLongest 每本书的作者」屏已删：它与 preferAuthor 高度重合
 * （同一批人换个口径再排一次），在 168px 的窄卡里不值得占掉一整屏轮播时间。
 */
function parseAuthorClouds(overall: Record<string, unknown> | null): ReadingCloud[] {
  const screens: ReadingCloud[] = [];

  const preferred = normalizeCloud(
    collectWords(
      overall?.preferAuthor,
      (it) => str(it.name),
      (it) => preferenceSeconds(it.readTime),
      (_it, w) => formatSecondsAsHours(w),
    ).slice(0, AUTHOR_CLOUD_MAX_WORDS),
  );
  if (preferred.length) screens.push({ label: "作者 · 按累计阅读时长", words: preferred });

  const categories = normalizeCloud(
    collectWords(
      overall?.preferCategory,
      (it) => str(it.categoryTitle),
      (it) => preferenceSeconds(it.readingTime),
      (_it, w) => formatSecondsAsHours(w),
    ).slice(0, AUTHOR_CLOUD_MAX_WORDS),
  );
  if (categories.length) screens.push({ label: "阅读分类 · 按时长", words: categories });

  return screens.filter((s) => s.words.length > 0);
}

/**
 * 出版社云图，一屏：合并 preferPublisher 与 preferCp（同名取较大本数）后按本数排序，
 * 取前 CLOUD_MAX_WORDS 家。一家都没有就整张卡不出现。
 *
 * 不再把第 7 名之后拆成第二、第三屏：一屏 6 家已经能把「谁占主导」说清楚，
 * 168px 的窄卡里为 4 本的几家再开两屏，轮播时间全花在长尾上。
 */
function parsePublisherClouds(overall: Record<string, unknown> | null): ReadingCloud[] {
  const merged = collectWords(
    [...(Array.isArray(overall?.preferPublisher) ? overall.preferPublisher : []),
     ...(Array.isArray(overall?.preferCp) ? overall.preferCp : [])],
    itemName,
    countWeight,
    (_it, w) => `${w} 本`,
  ).slice(0, CLOUD_MAX_WORDS);

  return merged.length ? [{ label: "出版社 · 读得最多", words: normalizeCloud(merged) }] : [];
}

/**
 * 累计阅读时段。preferTime 是 24 个秒数，从 6 时起排到次日 5 时；
 * 全为 0 时视为无数据，卡片少一屏。
 */
function parseHourly(overall: Record<string, unknown> | null): {
  hourly: number[];
  hourlyWord: string;
} {
  const raw = Array.isArray(overall?.preferTime) ? overall!.preferTime : [];
  const hourly = raw
    .slice(0, 24)
    .map((v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0));
  const hasData = hourly.some((v) => v > 0);
  const word = typeof overall?.preferTimeWord === "string" ? overall.preferTimeWord : "";
  return {
    hourly: hasData ? hourly : [],
    hourlyWord: hasData ? word : "",
  };
}

/**
 * 汇总网关回包。缺少必需字段即返回 null（fail closed），
 * 宁可卡片不显示，也不显示编造的数字。
 * 导出供 tests/weread-stats.test.mjs 直接校验。
 */
export function buildReadingStats(
  monthly: Record<string, unknown> | null,
  overall: Record<string, unknown> | null,
): ReadingStats | null {
  if (!monthly) return null;
  const monthMinutes = toMinutes(monthly.totalReadTime);
  if (monthMinutes === null || monthMinutes <= 0) return null;

  const { month, elapsedDays } = shanghaiMonthProgress();
  const daily = normalizeDaily(monthly.readTimes, month, elapsedDays);

  return {
    month,
    monthMinutes,
    monthDays: Number(monthly.readDays) || 0,
    daily,
    books: parseBooks(monthly.readLongest),
    summary: parseSummary(monthly),
    preferences: parsePreferences(overall),
    authorClouds: parseAuthorClouds(overall),
    publisherClouds: parsePublisherClouds(overall),
    ...parseHourly(overall),
    refreshedAt: Date.now(),
  };
}

/**
 * 只读缓存；缓存为空时回源一次并写回。
 *
 * 回源是为了让首次部署、TTL 过期或 Cron 尚未跑到时不至于整张卡长期缺席：
 * 第一个访客触发填充，后续访客只读缓存。回源预算单独设得比 Cron 更短，
 * 避免页面渲染被第三方接口拖住。任何失败都返回 null，不抛异常。
 */
export async function getReadingStats(): Promise<ReadingStats | null> {
  try {
    const redis = await getRedis();
    if (redis) {
      const cached = await redis.get<ReadingStats>(CACHE_KEY);
      if (cached && typeof cached === "object" && Array.isArray(cached.daily)) {
        return cached;
      }
    }

    const filled = await withDeadline(fetchReadingStats(), PAGEVIEW_FILL_TIMEOUT_MS);
    if (!filled) return null;
    if (redis) {
      try {
        await redis.set(CACHE_KEY, filled, { ex: CACHE_HARD_TTL_S });
      } catch (e) {
        console.warn("[weread] 回填缓存失败，本次仍返回数据:", e);
      }
    }
    return filled;
  } catch (e) {
    console.warn("[weread] 读缓存失败，按无数据处理:", e);
    return null;
  }
}

/** 超时即放弃并返回 null，不把异常抛给页面。定时器必须清掉，否则会挂住调用方的生命周期 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 直接向网关取一次并汇总，不读写缓存。
 * 供本地预览页使用：它要看的是真实排版与真实数字，但不该污染 Cron 维护的缓存。
 * 未配置 Key 时返回 null。
 */
export async function fetchReadingStats(): Promise<ReadingStats | null> {
  if (!apiKey()) return null;
  const monthly = await callGateway("/readdata/detail", { mode: "monthly" });
  if (!monthly) return null;
  const overall = await callGateway("/readdata/detail", { mode: "overall" });
  return buildReadingStats(monthly, overall);
}

/**
 * Cron 用：拉本月与累计两个周期并写缓存。
 * 返回 "ok" / "skipped"（未配置 Key）/ "failed"。不抛异常。
 * 失败时不写缓存，上一份数据继续可用。
 */
export async function refreshReadingStats(): Promise<"ok" | "skipped" | "failed"> {
  if (!apiKey()) return "skipped";

  const monthly = await callGateway("/readdata/detail", { mode: "monthly" });
  if (!monthly) return "failed";
  // 累计偏好是增强项：拿不到时仍写出本月数据，只是少几行偏好
  const overall = await callGateway("/readdata/detail", { mode: "overall" });

  const stats = buildReadingStats(monthly, overall);
  if (!stats) {
    console.warn("[weread] 回包缺少 totalReadTime，未写入缓存");
    return "failed";
  }

  const redis = await getRedis();
  if (!redis) return "failed";
  await redis.set(CACHE_KEY, stats, { ex: CACHE_HARD_TTL_S });
  return "ok";
}
