import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { rebuildTree } from "@/lib/tree/build";
import { getTree, isTreeStale, publicDiaryCount } from "@/lib/tree/store";

/**
 * 树数据读取入口。
 *
 * 数据源是 Redis（dr:tree:v1），构建期 tree.json 只作冷启动种子。读取时顺带判断
 * 是否需要重建：Notion webhook 会写 stale 标记；即使没配 webhook，这里也会比对
 * 公开条数，发现树上落后就走后台重建。重建在 waitUntil 里跑，本次请求仍返回旧树，
 * 访客不会等模型。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const tree = await getTree();

  let stale = await isTreeStale();
  if (!stale) {
    const liveCount = await publicDiaryCount();
    if (liveCount !== null && liveCount > tree.source.entries) stale = true;
  }
  if (stale) {
    waitUntil(
      rebuildTree().catch((error) => {
        console.warn("[tree] rebuild failed:", error);
      })
    );
  }

  return NextResponse.json(tree, {
    headers: {
      // 只缓存 1 分钟：重建完成后访客不用等一小时才看到新树。
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
