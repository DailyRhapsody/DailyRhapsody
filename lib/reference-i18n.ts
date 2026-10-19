// Reference 内容的英文层：摘要与公司档案字段由脚本预翻译后存 Redis，
// 渲染时按当前语言合并。原文（标题、正文）不翻译，避免机器翻译破坏专有名词。

import type { ReferenceCompanyProfile } from "@/lib/reference-profile";
import { getReferenceRedis } from "@/lib/notion-reference";

export const REFERENCE_EN_KEY = "dr:reference:en:v1";
export const REFERENCE_BODY_EN_KEY = "dr:reference:body:en:v1";

export type ReferenceEnFields = {
  summary?: string;
  company?: Partial<ReferenceCompanyProfile>;
};

/** 详情页正文英文层按条读取，避免整表把长文全塞进一次响应。 */
export async function getReferenceBodyEn(id: string): Promise<string | undefined> {
  const redis = await getReferenceRedis();
  if (!redis) return undefined;
  try {
    const raw = await redis.hget<string>(REFERENCE_BODY_EN_KEY, id);
    if (!raw) return undefined;
    if (typeof raw === "string") return raw;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一次取回整张翻译表：条目数在千级以内，整表读比逐条读省往返。
 * 复用 notion-reference 的 Redis 客户端，凭据解析与缓存层完全一致，
 * 避免自己拼 KV_REST_API_* / UPSTASH_* 时两套变量指向不同实例。
 */
export async function getReferenceEnMap(): Promise<Map<string, ReferenceEnFields>> {
  const redis = await getReferenceRedis();
  if (!redis) return new Map();
  const map = new Map<string, ReferenceEnFields>();
  try {
    const raw = await redis.hgetall<Record<string, ReferenceEnFields | string>>(REFERENCE_EN_KEY);
    if (!raw) return map;
    for (const [id, value] of Object.entries(raw)) {
      if (!value) continue;
      if (typeof value === "string") {
        try {
          map.set(id, JSON.parse(value) as ReferenceEnFields);
        } catch {
          // 单条脏数据不影响其它条目
        }
      } else {
        map.set(id, value);
      }
    }
  } catch {
    return map;
  }
  if (map.size === 0) console.warn("[reference-i18n] translation map is empty");
  return map;
}

type TranslatableItem = {
  id: string;
  name: string;
  titleZh?: string | null;
  summary: string;
  company?: ReferenceCompanyProfile | null;
};

/** 英文渲染：摘要与公司字段用译文，缺失时回落到中文原文。 */
export function applyReferenceEn<T extends TranslatableItem>(item: T, en?: ReferenceEnFields): T {
  if (!en) return item;
  return {
    ...item,
    summary: en.summary || item.summary,
    company: item.company
      ? { ...item.company, ...(en.company ?? {}) }
      : item.company,
  };
}
