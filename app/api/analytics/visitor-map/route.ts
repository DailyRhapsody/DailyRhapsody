import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { VISITOR_MAP_WINDOW_DAYS, getVisitorMapPayload } from "@/lib/analytics-store";
import { isAdmin } from "@/lib/auth";
import { guardApiRequest } from "@/lib/request-guard";
import { SCRAPE_GATE_COOKIE, verifyGateValue } from "@/lib/scrape-gate";

/**
 * /blog 底图用的公开聚合点位。
 *
 * 与 /api/analytics/collect 不同，这条是读取接口，所以：必须带 dr_gate 或管理员会话
 * （proxy.ts 的 matcher 与 protected public API 清单都列了它，所以中间件的 bot 拦截、IP 黑名单、
 * 全局限流、honeypot 记分同样覆盖本路径）、限流、半小时缓存；返回的只有格子级点位
 * （无 IP、无城市名、无精确坐标）。异常一律返回空点位而不是错误页：底图是装饰，缺了它页面照常。
 *
 * 限流排在鉴权之前：否则未鉴权的连发既不节流也不计违规（中间件之外还有一层兜底）。
 * 不强设 Cache-Control：受保护路径由 withAntiScrapeHeaders 统一给 private, no-store。
 */
export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "analytics:visitormap",
    limit: 60,
    windowMs: 60_000,
    blockSuspicious: false,
    checkOrigin: false,
    checkSecFetch: false,
  });
  if (blocked) return blocked;

  const gate = (await cookies()).get(SCRAPE_GATE_COOKIE)?.value;
  if (!verifyGateValue(gate) && !(await isAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return NextResponse.json(await getVisitorMapPayload());
  } catch (e) {
    console.warn("[analytics] visitor-map failed:", e);
    return NextResponse.json({
      points: [],
      generatedAt: new Date().toISOString(),
      windowDays: VISITOR_MAP_WINDOW_DAYS,
    });
  }
}
