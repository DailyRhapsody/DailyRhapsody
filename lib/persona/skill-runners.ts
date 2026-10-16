/**
 * Skill 的服务端实现登记表。
 *
 * 与 lib/persona/skills.ts 的分工：那边是客户端也读得到的目录（按钮文字、提示、进度），
 * 这边是只有服务端能加载的实现。分两个文件是因为实现会 import node:crypto 与
 * @upstash/redis，混在一起会把服务端依赖带进浏览器产物。
 *
 * SKILL_RUNNERS 的类型是 Record<SkillId, SkillRunner>，不是 Partial：目录里加了 skill
 * 而这里没登记，编译即失败。这是这个框架「不漏」的保证。
 */

import { IncompleteAnalysisSourceError } from "@/lib/notion";
import { runCoreValues } from "@/lib/persona/core-values-route";
import { runFirstPrinciples } from "@/lib/persona/first-principles-route";
import type { SkillId } from "@/lib/persona/skills";

export type SkillContext = {
  req: Request;
  /** 额度闸门。返回非空表示已拒绝，调用方原样把它交给访客。 */
  authorize: () => Promise<Response | null>;
};

/** 面向访客的失败描述，由调用方套上统一的响应包装 */
export type SkillFailure = { status: number; error: string };

export type SkillRunner = {
  run: (ctx: SkillContext) => Promise<Response>;
  /**
   * 把实现抛出的异常翻译成访客可读的失败。返回 null 表示交给目录里的通用文案。
   * 各 skill 自己认领异常，调用方因此不需要认识任何一个 skill 的错误类型。
   */
  failure?: (e: unknown) => SkillFailure | null;
};

export const SKILL_RUNNERS: Record<SkillId, SkillRunner> = {
  "first-principles": {
    run: ({ req, authorize }) => runFirstPrinciples(req, authorize),
    failure: (e) =>
      e instanceof IncompleteAnalysisSourceError
        ? {
            status: 422,
            error: `${e.count} 篇公开文章含尚未完整读取的文字，请补齐正文后再分析。`,
          }
        : null,
  },
  "core-values": {
    run: ({ req, authorize }) => runCoreValues(req, authorize),
    // 与第一个 skill 读同一份来源，正文不完整时的失败形状相同，文案可共用
    failure: (e) =>
      e instanceof IncompleteAnalysisSourceError
        ? {
            status: 422,
            error: `${e.count} 篇公开文章含尚未完整读取的文字，请补齐正文后再分析。`,
          }
        : null,
  },
};

export function skillRunner(id: SkillId): SkillRunner {
  return SKILL_RUNNERS[id];
}
