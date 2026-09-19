/**
 * 人设包契约。
 *
 * 人设内容由私有目录（~/AI/persona-lab）离线蒸馏生成，发布到 Upstash；
 * 本仓库是公开仓库，只认这个结构，不含任何人设正文。
 *
 * 分两级、物理上是两个 key：
 * - public：访客模式。风格与思维可来自全部素材，但事实只来自已公开内容。
 *   访客能通过提示注入把上下文整段套出来，所以这一级里放的东西要当作已公开。
 * - owner：本人模式（管理员会话）。可含全部记忆。
 */
export type PersonaTier = "public" | "owner";

export type PersonaNote = {
  id: string;
  title: string;
  text: string;
  /** YYYY-MM-DD，可缺省 */
  date?: string;
};

export type PersonaExemplar = { user: string; reply: string };

export type PersonaBundle = {
  schema: 1;
  tier: PersonaTier;
  /** ISO 时间，便于排查线上跑的是哪一版 */
  builtAt: string;
  /** 以下各段均为写给模型看的 markdown */
  identity: string;
  voice: string;
  logic: string;
  memory: string;
  boundaries: string;
  /** 语气示范，只示范说法，不作事实来源 */
  exemplars: PersonaExemplar[];
  /** 可检索的补充记忆片段；访客级只放可公开条目 */
  notes: PersonaNote[];
  /** 面板空状态的开场建议问题 */
  starters: string[];
  /** 访客检索时排除的博客标签（回避主题）；文章照常公开，只是数字人不引用 */
  avoidTags: string[];
  /** 访客检索时逐篇排除的文章（Notion 页面 id）：标签太宽、按标签排除会误伤时用 */
  avoidIds: string[];
};

const MAX_SECTION_CHARS = 60_000;
const MAX_NOTES = 5_000;

function str(v: unknown, max = MAX_SECTION_CHARS): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** 读入时做结构校验：发布脚本出错时宁可当作「未发布」，也不把半截数据塞给模型。 */
export function parsePersonaBundle(raw: unknown, tier: PersonaTier): PersonaBundle | null {
  const obj = typeof raw === "string" ? safeJson(raw) : raw;
  if (!obj || typeof obj !== "object") return null;
  const b = obj as Record<string, unknown>;
  if (b.schema !== 1 || b.tier !== tier) return null;
  const identity = str(b.identity);
  const voice = str(b.voice);
  if (!identity || !voice) return null;

  const exemplars = Array.isArray(b.exemplars)
    ? b.exemplars
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({ user: str(e.user, 2_000), reply: str(e.reply, 4_000) }))
        .filter((e) => e.user && e.reply)
        .slice(0, 40)
    : [];
  const notes = Array.isArray(b.notes)
    ? b.notes
        .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
        .map((n) => ({
          id: str(n.id, 200),
          title: str(n.title, 200),
          text: str(n.text, 20_000),
          date: str(n.date, 10) || undefined,
        }))
        .filter((n) => n.id && n.text)
        .slice(0, MAX_NOTES)
    : [];
  const starters = Array.isArray(b.starters)
    ? b.starters.map((s) => str(s, 60)).filter(Boolean).slice(0, 4)
    : [];
  const avoidTags = Array.isArray(b.avoidTags)
    ? b.avoidTags.map((t) => str(t, 20).trim()).filter(Boolean).slice(0, 100)
    : [];
  const avoidIds = Array.isArray(b.avoidIds)
    ? b.avoidIds.map((t) => str(t, 64).trim()).filter(Boolean).slice(0, 2_000)
    : [];

  return {
    schema: 1,
    tier,
    builtAt: str(b.builtAt, 40),
    identity,
    voice,
    logic: str(b.logic),
    memory: str(b.memory),
    boundaries: str(b.boundaries),
    exemplars,
    notes,
    starters,
    avoidTags,
    avoidIds,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
