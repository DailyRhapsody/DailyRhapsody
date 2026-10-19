// Reference 内容的英文层：摘要与公司档案字段由脚本预翻译后存 Redis，
// 渲染时按当前语言合并。原文（标题、正文）不翻译，避免机器翻译破坏专有名词。

import type { ReferenceCompanyProfile } from "@/lib/reference-profile";

export const REFERENCE_EN_KEY = "dr:reference:en:v1";

export type ReferenceEnFields = {
  summary?: string;
  company?: Partial<ReferenceCompanyProfile>;
};

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_READ_ONLY_TOKEN ??
    process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

/** 一次取回整张翻译表：条目数在千级以内，整表读比逐条读省往返。 */
export async function getReferenceEnMap(): Promise<Map<string, ReferenceEnFields>> {
  const config = redisConfig();
  if (!config) return new Map();
  try {
    const res = await fetch(`${config.url}/hgetall/${REFERENCE_EN_KEY}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
    });
    if (!res.ok) return new Map();
    const body = (await res.json()) as { result?: (string | null)[] | null };
    const flat = body.result ?? [];
    const map = new Map<string, ReferenceEnFields>();
    for (let i = 0; i < flat.length; i += 2) {
      const id = flat[i];
      const raw = flat[i + 1];
      if (!id || !raw) continue;
      try {
        map.set(id, JSON.parse(raw) as ReferenceEnFields);
      } catch {
        // 单条脏数据不影响其它条目
      }
    }
    return map;
  } catch {
    return new Map();
  }
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
