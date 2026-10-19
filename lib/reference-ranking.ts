/**
 * Reference 顶部排行榜。
 *
 * 旧规则只按 ClippedAt 倒序，等价于「最近入库」；现在把可观测的互动信号
 * 和新鲜度合成一个分数：
 *   - 浏览量：详情页每次打开 +1
 *   - 下载量：/api/download/reference/[id] 的既有计数
 *   - 点赞量：匿名设备点赞集合大小
 *   - 评论量：Reference 独立评论键空间
 *   - 热度：上述互动信号的加权对数（避免单条爆量霸榜）
 *   - 时间：CollectedAt 的新鲜度衰减，鼓励近期资料
 *
 * 计数读取失败时回退为纯时间排序，不阻塞顶部卡片。
 */
import { Redis } from "@upstash/redis";
import type { ReferenceItem } from "@/lib/notion-reference";
import { getReferenceCommentCounts } from "@/lib/reference-comments";

const VIEW_PREFIX = "dr:ref:view:";
const DOWNLOAD_PREFIX = "dr:ref:dl:";
const LIKE_PREFIX = "dr:ref:likes:";
const VIEW_TTL_S = 180 * 24 * 60 * 60;

let _redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

export type ReferenceRankItem = {
  id: string;
  title: string;
  score: number;
  views: number;
  downloads: number;
  likes: number;
  comments: number;
};

function ageDays(iso: string, now: number): number {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 365;
  return Math.max(0, (now - time) / 86_400_000);
}

/** 详情页读取一次；失败不影响页面。 */
export async function recordReferenceView(id: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const key = `${VIEW_PREFIX}${id}`;
    await redis.incr(key);
    await redis.expire(key, VIEW_TTL_S);
  } catch {
    // ignore
  }
}

export async function rankReferenceTop(
  items: ReferenceItem[],
  limit = 5,
): Promise<ReferenceRankItem[]> {
  const publicItems = items.filter((item) => item.isPublic);
  const now = Date.now();
  const fallback = [...publicItems]
    .sort((a, b) => Date.parse(b.clippedAt) - Date.parse(a.clippedAt))
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: item.titleZh?.trim() || item.name,
      score: 0,
      views: 0,
      downloads: 0,
      likes: 0,
      comments: 0,
    }));

  const redis = getRedis();
  if (!redis || publicItems.length === 0) return fallback;

  try {
    const ids = publicItems.map((item) => item.id);
    const comments = await getReferenceCommentCounts(new Set(ids));
    const pipe = redis.pipeline();
    for (const id of ids) {
      pipe.get(`${VIEW_PREFIX}${id}`);
      pipe.get(`${DOWNLOAD_PREFIX}${id}`);
      pipe.scard(`${LIKE_PREFIX}${id}`);
    }
    const raw = await pipe.exec();

    const ranked = publicItems.map((item, index) => {
      const views = Number(raw[index * 3]) || 0;
      const downloads = Number(raw[index * 3 + 1]) || 0;
      const likes = Number(raw[index * 3 + 2]) || 0;
      const commentCount = Number(comments[item.id]) || 0;
      const heat =
        Math.log1p(views) +
        Math.log1p(downloads) * 1.8 +
        Math.log1p(likes) * 2.2 +
        Math.log1p(commentCount) * 1.4;
      const recency = Math.max(0, 1 - ageDays(item.clippedAt, now) / 540) * 8;
      return {
        id: item.id,
        title: item.titleZh?.trim() || item.name,
        score: heat * 10 + recency,
        views,
        downloads,
        likes,
        comments: commentCount,
      };
    });

    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
  } catch {
    return fallback;
  }
}
