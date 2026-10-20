import type { PersonaBundle } from "@/lib/persona/types";

/**
 * 每日一句：右下角数字人上方的一句话，每天生成一次，取公开人设包的画像作底，
 * 借一句公认名言的思路重新写成一句新的话。
 *
 * 三条不变式：
 * - 只用 public 包。这句话会原样展示给所有访客，等同于公开内容，不能带 owner 包的任何东西。
 * - 每天只生成一次。同一日期命中同一条缓存；键里带日期，跨天自然换新，不写死 24 小时，
 *   否则前一天 23:00 生成的句子会活到第二天 23:00。
 * - 输出不署名、不出现名人姓名。它是重写后的新句子，不是名言摘抄；把「——某某」写上去
 *   等于给了读者一个可以核对出处的引文，而它并不存在。
 *
 * 缓存、并发生成与失败兜底在路由层（app/api/persona/daily-quote），这里只放纯逻辑，便于单测。
 */

export const DAILY_QUOTE_VERSION = "v1";

/** 一句话的上限：超过就不是「一句」了，宁可不展示也不把半段文章塞到宠物头顶 */
export const DAILY_QUOTE_MAX_CHARS = 60;

/** 画像送进提示词的字符预算，避免把整个记忆段塞给模型 */
const IDENTITY_CHARS = 1_200;
const LOGIC_CHARS = 2_000;
const MEMORY_CHARS = 1_800;

export type SeedQuote = { text: string; author: string; source?: string };

/**
 * 种子名言。只用出处明确、无版权争议的短句；模型只借它的意思，不引用原句。
 * 顺序固定，按日期哈希取一条——同一天所有实例拿到同一条，且相邻两天不重复。
 */
export const SEED_QUOTES: SeedQuote[] = [
  { text: "学而不思则罔，思而不学则殆。", author: "孔子", source: "《论语·为政》" },
  { text: "千里之行，始于足下。", author: "老子", source: "《道德经》" },
  { text: "不积跬步，无以至千里。", author: "荀子", source: "《劝学》" },
  { text: "知是行之始，行是知之成。", author: "王阳明", source: "《传习录》" },
  { text: "未经省察的人生不值得过。", author: "苏格拉底" },
  { text: "人是一根会思想的芦苇。", author: "帕斯卡", source: "《思想录》" },
  { text: "一个人知道自己为什么而活，就可以忍受任何一种生活。", author: "尼采", source: "《偶像的黄昏》" },
  { text: "哪有什么胜利，挺住意味着一切。", author: "里尔克", source: "《安魂曲》" },
  { text: "在冬天的深处，我终于明白，我身上有一个不可战胜的夏天。", author: "加缪", source: "《回归蒂巴萨》" },
  { text: "语言的界限，就是我的世界的界限。", author: "维特根斯坦", source: "《逻辑哲学论》" },
  { text: "其实地上本没有路，走的人多了，也便成了路。", author: "鲁迅", source: "《故乡》" },
  { text: "世界上只有一种真正的英雄主义，那就是认清生活的真相之后依然热爱生活。", author: "罗曼·罗兰", source: "《米开朗琪罗传》" },
  { text: "这个世界如此美好，值得人们为它奋斗。", author: "海明威", source: "《丧钟为谁而鸣》" },
  { text: "世界以痛吻我，要我报之以歌。", author: "泰戈尔", source: "《飞鸟集》" },
  { text: "回首向来萧瑟处，归去，也无风雨也无晴。", author: "苏轼", source: "《定风波》" },
  { text: "盛年不重来，一日难再晨。", author: "陶渊明", source: "《杂诗》" },
];

/** 北京时间的日期（YYYY-MM-DD）。服务器时区不一定是东八区，缓存键必须与读者看到的「今天」一致。 */
export function todayInBeijing(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(now);
}

/** 按日期取种子名言：同一日期稳定，相邻日期轮换。 */
export function pickSeedQuote(date: string): SeedQuote {
  let hash = 0;
  for (let i = 0; i < date.length; i++) hash = (hash * 31 + date.charCodeAt(i)) >>> 0;
  return SEED_QUOTES[hash % SEED_QUOTES.length];
}

/** 当天缓存的键。版本号随提示词变化升级：旧句子是按旧规则写的，不该继续展示。 */
export function dailyQuoteKey(date: string): string {
  return `dr:persona:daily-quote:${DAILY_QUOTE_VERSION}:${date}`;
}

export function dailyQuoteLockKey(date: string): string {
  return `${dailyQuoteKey(date)}:lock`;
}

/**
 * 距北京时间次日的秒数，作为缓存 TTL。用「到点过期」而不是固定 24 小时：
 * 固定 24 小时会让当天 23:00 生成的句子留到第二天 23:00，读者在隔天上午看到的还是昨天那句。
 */
export function secondsUntilNextBeijingDay(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const used = value("hour") * 3600 + value("minute") * 60 + value("second");
  return Math.max(60, 86_400 - used);
}

function section(title: string, body: string, max: number): string {
  const text = body.trim().slice(0, max);
  return text ? `### ${title}\n${text}` : "";
}

export function dailyQuotePrompt(bundle: PersonaBundle, seed: SeedQuote, date: string): string {
  const profile = [
    section("我是谁", bundle.identity, IDENTITY_CHARS),
    section("我怎么想问题", bundle.logic, LOGIC_CHARS),
    section("我记得的事", bundle.memory, MEMORY_CHARS),
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    `今天是 ${date}。你要以滕君的口吻，在他的博客右下角写一句给访客看的话。`,
    "",
    "## 我的公开画像",
    profile,
    "",
    "## 今天借用的思想",
    `「${seed.text}」——${seed.author}${seed.source ? `，${seed.source}` : ""}`,
    "只借这层意思，不引用它的句子，也不出现作者的名字或书名。",
    "",
    "## 写法",
    "1. 从画像里挑一个真实的态度、取舍或经历，用我说话的方式重写成一句新的话，二十五到四十五个汉字。",
    "2. 它是今天新写的判断，不是名言的白话翻译，也不是通用鸡汤；读者读完应能看出这是我的看法。",
    "3. 不用引号、书名号、破折号；不署名，不出现任何人的姓名。",
    "4. 不用感叹号、问号、省略号；不用「不是……而是……」这类对举句式，不用排比。",
    "5. 只输出这句话本身：不要标题、不要解释、不要换行。",
  ].join("\n");
}

const WRAPPING = /^[「『“"‘']+|[」』”"’']+$/g;

function stripWrapping(text: string): string {
  let out = text.trim();
  // 成对包裹的引号最多剥两层，模型偶尔会写「“……”」
  for (let i = 0; i < 2; i++) out = out.replace(WRAPPING, "").trim();
  return out;
}

/**
 * 清洗模型输出。解析不出合格的一句话就返回 null，路由层据此当作「今天没有」，
 * 下次请求重试——宁可不显示，也不把标题、解释或半句话挂到宠物头上。
 */
export function parseDailyQuote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return null;

  let text = first
    .replace(/^[#>*\-\s]+/, "")
    .replace(/^(每日一句|今日一句|今天的一句话)\s*[:：]\s*/, "")
    .replace(/\*\*/g, "");
  // 署名与后面的一切都丢掉：「……」——某某、《书名》
  text = text.split("——")[0].split("--")[0];
  text = stripWrapping(text);
  // 句内引号同样去掉：这句话不引用任何人
  text = text.replace(/[「」『』“”"]/g, "").replace(/\s+/g, " ").trim();
  // 结尾标点归一：模型偶尔带感叹号或问号，与「陈述一句」的定位不符
  text = text.replace(/[。！？!?；;，,、]+$/u, "。").trim();

  if (!text || text === "。") return null;
  if (/^(抱歉|对不起|我无法|作为一个?AI)/.test(text)) return null;
  const chars = [...text].length;
  if (chars < 8 || chars > DAILY_QUOTE_MAX_CHARS) return null;
  return text;
}
