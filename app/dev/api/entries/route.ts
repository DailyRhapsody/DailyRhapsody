import { NextResponse } from "next/server";
import { loadLocalDiaries } from "@/lib/dev-snapshot";
import { countPostsByDate } from "@/lib/post-activity";

/**
 * 本地预览专用的只读文章接口（只在非生产环境提供，生产返回 404）。
 *
 * 与 /api/diaries 共用 lib/dev-snapshot 里同一份快照读取实现，只是多一个免 gate 的入口：
 * /api/* 受中间件保护，而预览页自身不在保护范围内，用这个路径可免去 PoC 握手的交互。
 */
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const items = await loadLocalDiaries();
  if (!items) {
    return NextResponse.json(
      { error: "本地快照不存在", detail: "把主目录的 data/diaries.json 复制到本工作区 data/ 下" },
      { status: 404 },
    );
  }

  const tagCount = new Map<string, number>();
  for (const d of items) {
    for (const t of d.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  }
  const postCounts = countPostsByDate(items);

  return NextResponse.json({
    items,
    total: items.length,
    tagCounts: [...tagCount.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value),
    dates: Object.keys(postCounts),
    dateCounts: postCounts,
    source: "data/diaries.json（本机脱敏只读快照，非生产数据源）",
  });
}
