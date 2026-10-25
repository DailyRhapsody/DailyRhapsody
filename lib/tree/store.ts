import { Redis } from "@upstash/redis";
import seedTreeJson from "@/public/tree/tree.json";
import seedTaxonomyJson from "@/public/tree/taxonomy.json";

/**
 * 思维大树的数据存取层。
 *
 * 树数据从「构建期静态 JSON」改成「运行时 Redis + 构建期种子兜底」的原因：
 * 树要跟着博客更新增长，而重建结果写不回 serverless 的文件系统；只有落 Redis，
 * 下一轮部署之前也能立刻生效。种子仍随仓库发布，缓存被清空时不会白屏。
 */

export type TreeEntry = { id: string; date: string; t: number; sub: string; name?: string };

export type TreeSub = { name: string; count: number };

export type TreeTopic = {
  id: string;
  name: string;
  subs: TreeSub[];
  entries: TreeEntry[];
};

export type TreeFamily = { id: string; name: string; topics: TreeTopic[] };

export type TreeData = {
  schema: string;
  generatedAt: string;
  epochMonth: number;
  lastDate: string;
  source: { entries: number; public: number };
  families: TreeFamily[];
};

export type TaxonomySub = string;
export type TaxonomyTopic = { name: string; subs: TaxonomySub[] };
export type TaxonomyFamily = { name: string; topics: TaxonomyTopic[] };
export type Taxonomy = { families: TaxonomyFamily[] };

export type Classification = { family: string; topic: string; sub: string };

const TREE_KEY = "dr:tree:v1";
const TAXONOMY_KEY = "dr:tree:taxonomy:v1";
const STALE_KEY = "dr:tree:stale";
const BUILD_LOCK_KEY = "dr:tree:build:lock";
const BUILD_LOCK_TTL_S = 900;

let _redis: Redis | null | undefined;

export function getTreeRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

export function seedTree(): TreeData {
  return seedTreeJson as unknown as TreeData;
}

export function seedTaxonomy(): Taxonomy {
  return seedTaxonomyJson as unknown as Taxonomy;
}

/** Redis 优先；没有 Redis 或缓存为空时回落到仓库里的种子。 */
export async function getTree(): Promise<TreeData> {
  const redis = getTreeRedis();
  if (!redis) return seedTree();
  try {
    const cached = await redis.get<TreeData>(TREE_KEY);
    if (cached && Array.isArray(cached.families) && cached.families.length) return cached;
  } catch {
    /* 读失败按缓存缺失处理，种子仍可展示 */
  }
  return seedTree();
}

export async function saveTree(tree: TreeData): Promise<void> {
  const redis = getTreeRedis();
  if (!redis) return;
  await redis.set(TREE_KEY, tree);
}

export async function getTaxonomy(): Promise<Taxonomy> {
  const redis = getTreeRedis();
  if (!redis) return seedTaxonomy();
  try {
    const cached = await redis.get<Taxonomy>(TAXONOMY_KEY);
    if (cached && Array.isArray(cached.families) && cached.families.length) return cached;
  } catch {
    /* 同上，回落到冻结的种子体系 */
  }
  return seedTaxonomy();
}

export async function saveTaxonomy(taxonomy: Taxonomy): Promise<void> {
  const redis = getTreeRedis();
  if (!redis) return;
  await redis.set(TAXONOMY_KEY, taxonomy);
}

/** Notion 内容变更时只打标记，重建留给读请求在后台执行，webhook 保持秒回。 */
export async function markTreeStale(): Promise<void> {
  const redis = getTreeRedis();
  if (!redis) return;
  try {
    await redis.set(STALE_KEY, Date.now(), { ex: 60 * 60 * 24 * 7 });
  } catch {
    /* 标记写失败不阻断内容刷新 */
  }
}

export async function clearTreeStale(): Promise<void> {
  const redis = getTreeRedis();
  if (!redis) return;
  try {
    await redis.del(STALE_KEY);
  } catch {
    /* 同上 */
  }
}

export async function isTreeStale(): Promise<boolean> {
  const redis = getTreeRedis();
  if (!redis) return false;
  try {
    return Boolean(await redis.get(STALE_KEY));
  } catch {
    return false;
  }
}

/** 跨实例重建锁：并发读请求同时发现 stale 时只允许一个真的跑模型。 */
export async function acquireBuildLock(): Promise<boolean> {
  const redis = getTreeRedis();
  if (!redis) return false;
  try {
    const ok = await redis.set(BUILD_LOCK_KEY, Date.now(), { nx: true, ex: BUILD_LOCK_TTL_S });
    return ok === "OK";
  } catch {
    return false;
  }
}

export async function releaseBuildLock(): Promise<void> {
  const redis = getTreeRedis();
  if (!redis) return;
  try {
    await redis.del(BUILD_LOCK_KEY);
  } catch {
    /* 租约到期会自动释放 */
  }
}

/** 当前公开日记条数：只读缓存，不触发回源。冷启动返回 null 时跳过落后检测。 */
export async function publicDiaryCount(): Promise<number | null> {
  const { getCachedDiaries } = await import("@/lib/notion");
  const diaries = await getCachedDiaries();
  if (!diaries) return null;
  return diaries.filter((entry) => entry.isPublic !== false).length;
}
