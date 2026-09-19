/**
 * 数字人开关：NEXT_PUBLIC_PET_MODE
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
