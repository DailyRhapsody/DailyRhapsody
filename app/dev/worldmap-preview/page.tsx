import { notFound } from "next/navigation";
import WorldMapPreviewClient from "./WorldMapPreviewClient";

/**
 * 首页底图（像素世界地图 + 访客光点）的本地预览。
 *
 * 渲染的是 /blog 上线的同一个 VisitorWorldMap 组件，光点用示意分布，多一个强度滑块用来定档。
 * 生产环境返回 404，避免误上线；定稿后可连同本目录一并删除。
 */
export default function WorldMapPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <WorldMapPreviewClient />;
}
