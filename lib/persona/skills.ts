/**
 * AI-Persona 的 Skill 目录。
 *
 * 一个 Skill 是一次「服务器固定任务」：访客点一下按钮，服务端按预设提示词与流程
 * 跑完，返回一份结果。它与普通聊天共用 /api/chat 这条通道、同一套限流与额度，
 * 区别只在请求体带 `skill` 字段，提示词与流程由服务端决定，访客输入不参与。
 *
 * 本文件必须保持客户端安全。对话面板要按这张表渲染按钮，所以这里只放纯数据与类型，
 * 不得 import node:crypto、@upstash/redis 或任何具体实现。
 * 可执行的实现登记在 lib/persona/skill-runners.ts，那张表按 SkillId 穷举：
 * 这里加一个 skill 而那边忘了登记，编译就会失败。
 *
 * `id` 进请求体，也会被写进访客的对话历史，属于协议字段：改名等于让历史会话
 * 对不上号。要改对外称呼就改 label。
 */

/** 分析类 skill 计全站分析额度，不消耗访客的普通聊天轮次 */
export type SkillQuota = "analysis";

export type SkillMeta = {
  /** 协议字段，改名会与已存的对话历史脱节 */
  id: string;
  /** 按钮文字，同时作为无障碍名称 */
  label: string;
  /** 悬停提示，一句话说清点了会得到什么 */
  hint: string;
  /** 等待首包期间显示；服务端在返回 202 之前不会给出更细的进度 */
  progress: string;
  /** 作为访客那条消息写进对话，让历史记录自带这次请求的意图 */
  prompt: string;
  quota: SkillQuota;
  /** 实现抛出未映射异常时给访客看的话 */
  failure: string;
};

export const SKILLS = [
  {
    id: "first-principles",
    label: "第一性原理洞察",
    hint: "分析全部公开文章，归纳共同前提、跨篇联系、反例与观点变化",
    progress: "正在读取公开文章",
    prompt: "用第一性原理洞察全部公开文章，梳理共同前提、跨篇联系和观点变化。",
    quota: "analysis",
    failure: "本次分析未完成，已保留进度，请重试。",
  },
  {
    // 与第一条共用同一批公开文章与同一份分析额度，但产出的是价值层结论：
    // 取舍方向与排序，而不是命题层的共同前提。
    id: "core-values",
    label: "核心价值观",
    hint: "分析全部公开文章，归纳作者看重的价值、取舍代价与价值排序",
    progress: "正在读取公开文章",
    prompt: "用核心价值观分析全部公开文章，梳理价值取向、取舍代价与价值排序。",
    quota: "analysis",
    failure: "本次分析未完成，已保留进度，请重试。",
  },
] as const satisfies readonly SkillMeta[];

/** 目录条目的联合类型。id 保持字面量，查表之后才能直接当作 SkillId 用。 */
export type SkillCatalogEntry = (typeof SKILLS)[number];
export type SkillId = SkillCatalogEntry["id"];

/**
 * 编译期断言，不产生运行期代码。
 *
 * 上面那句 `as const` 是「不漏」这条保证的唯一支点：一旦被当作冗余删掉，
 * SkillId 会被拓宽成 string，skill-runners 里的 Record<SkillId, SkillRunner>
 * 随即退化成 Record<string, …>，而 tsc、单测与 next build 会全部通过——
 * 新增 skill 忘登记就不再报错，保证静默消失。这行让那种改动直接编译失败。
 */
type AssertTrue<T extends true> = T;
export type SkillIdStaysLiteral = AssertTrue<string extends SkillId ? false : true>;

const BY_ID = new Map<string, SkillCatalogEntry>(SKILLS.map((s) => [s.id, s]));

/** 校验请求体里的 skill 字段。非字符串、未登记的一律返回 null，由调用方拒绝。 */
export function findSkill(id: unknown): SkillCatalogEntry | null {
  return typeof id === "string" ? BY_ID.get(id) ?? null : null;
}
