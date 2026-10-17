import { NextResponse } from "next/server";
import tree from "@/public/tree/tree.json";

/**
 * 树数据由 scripts/tree/analyze.mjs 离线生成：
 * 模型阅读公开日记摘要后产出家族/中类/细类，产物只含标签、ID 与日期。
 * 这里只读静态产物，不在请求内运行模型，也不读取正文。
 */
export const revalidate = 3600;

export async function GET() {
  return NextResponse.json(tree, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
