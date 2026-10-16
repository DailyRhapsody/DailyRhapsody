import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diary } from "@/lib/notion";

/**
 * 本地预览用的脱敏只读文章快照。
 *
 * 为什么存在：仓库的数据层只走 Notion，本地没有 NOTION_TOKEN 时 /api/diaries 直接 503，
 * 于是 /blog 永远显示「暂无文章」，看不出透光底图与排版的真实效果。主目录里本来就有
 * 一份 data/diaries.json（159 篇，导出快照），这里把它按 Diary 形状归一化后喂给同一个接口，
 * 渲染走的仍是上线的组件与样式。
 *
 * 边界：只在非生产环境可用；不读生产 Notion、不碰 Redis、不写缓存；/data/ 在 .gitignore 里，不入库。
 */
export function isLocalSnapshotEnabled(): boolean {
  return process.env.VERCEL_ENV !== "production";
}

type SnapshotRow = {
  id?: string | number;
  date?: string;
  publishedAt?: string;
  pinned?: string | boolean;
  summary?: string;
  location?: string;
  tags?: string | string[];
  images?: string | string[];
};

/** 快照里布尔与数组是以字符串形式存的（"False" / "['媒体', '环境']"），这里做一次归一化 */
function parseListField(raw: string | string[] | undefined): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

function normalize(row: SnapshotRow): Diary | null {
  const id = row.id == null ? "" : String(row.id); // 快照里的 id 是数字，别按字符串判
  const date = typeof row.date === "string" ? row.date : "";
  if (!id || !date) return null;
  return {
    id,
    date,
    publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : undefined,
    pinned: row.pinned === true || row.pinned === "True",
    isPublic: true,
    summary: typeof row.summary === "string" ? row.summary : "",
    location: row.location ? String(row.location) : undefined,
    tags: parseListField(row.tags),
    // 图片走 /api/media 代理，本地没有 Notion 凭证取不到；预览里不显示，免得一排加载失败的占位
    images: [],
  };
}

/** 读本机快照；环境不对或文件缺失时返回 null，由调用方决定报什么错。 */
export async function loadLocalDiaries(): Promise<Diary[] | null> {
  if (!isLocalSnapshotEnabled()) return null;

  let rows: SnapshotRow[];
  try {
    rows = JSON.parse(
      await readFile(join(process.cwd(), "data", "diaries.json"), "utf8"),
    ) as SnapshotRow[];
  } catch {
    return null;
  }

  return rows
    .map(normalize)
    .filter((d): d is Diary => d !== null)
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.publishedAt ?? b.date).localeCompare(a.publishedAt ?? a.date);
    });
}
