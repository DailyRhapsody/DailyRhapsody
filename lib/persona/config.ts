/**
 * AI-Persona 开关：NEXT_PUBLIC_PET_MODE
 * - off（默认）：不渲染宠物，/api/chat 返回 404。合进 main 后线上零变化。
 * - owner：宠物只对已登录管理员显示，用于上线前自己试聊、校人设；线上内容仍是 public 包。
 * - public：对所有访客开放。
 *
 * NEXT_PUBLIC_ 前缀让客户端与服务端读到同一个值（客户端在构建时内联，改了要重新部署）。
 */
export type PetMode = "off" | "owner" | "public";

export function getPetMode(): PetMode {
  const v = process.env.NEXT_PUBLIC_PET_MODE?.trim().toLowerCase();
  return v === "owner" || v === "public" ? v : "off";
}

/** 访客额度。滑动窗口，不是自然日清零。 */
export const CHAT_LIMITS = {
  burstPerMinute: 8,
  dailyPerIp: 30,
  dailyGlobal: 600,
  maxTurns: 16,
  maxUserChars: 2_000,
  maxAssistantChars: 4_000,
  maxBodyBytes: 64 * 1024,
  maxOutputTokensPublic: 700,
  maxOutputTokensOwner: 2_000,
  /** 低于 Vercel 函数时长上限，留出收尾时间 */
  upstreamTimeoutMs: 55_000,
} as const;

/**
 * agent 模式（工具+自主循环）的开关与预算。默认 off；灰度顺序：owner（只本人）→ on（全体）。
 * 服务端开关（非 NEXT_PUBLIC），改值需要一次部署才生效；关闭即回到单步直答，随时可回滚。
 */
export type AgentMode = "off" | "owner" | "on";

export function getAgentMode(): AgentMode {
  const v = process.env.PERSONA_AGENT_MODE?.trim().toLowerCase();
  return v === "owner" || v === "on" ? v : "off";
}

export const AGENT_LIMITS = {
  /** 含首调在内的模型调用上限；最后一轮强制收尾作答（tool_choice=none） */
  maxModelCalls: 5,
  /** 工具执行次数上限；同参重复的调用不重复执行、也不计入（停滞守卫） */
  maxToolCalls: 4,
  /** 单步（一次模型调用）超时，对齐普通路径的上游预算 */
  perStepTimeoutMs: 55_000,
  /** 整个循环的总预算；NDJSON 首包即达，不受前端 65s 首包限制 */
  totalDeadlineMs: 150_000,
  /** 单条工具结果的字符上限（tool-runners 内截断） */
  maxToolResultChars: 8_000,
  /** 全站每日步数预算（费用闸）：一次模型调用记一步 */
  siteDailySteps: 1_500,
} as const;
