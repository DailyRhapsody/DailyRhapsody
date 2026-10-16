import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getVisitorMapPayload } from "@/lib/analytics-store";
import { isAdmin } from "@/lib/auth";
import { guardApiRequest } from "@/lib/request-guard";
import { SCRAPE_GATE_COOKIE, verifyGateValue } from "@/lib/scrape-gate";

/**
 * /blog 底图用的公开聚合点位。
 *
 * 与 /api/analytics/collect 不同，这条是读取接口，所以：必须带 dr_gate（proxy.ts 也把它列进
 * 受保护 public API）、限流、半小时缓存；返回的只有格子级点位（无 IP、无城市名、无精确坐标）。
 * 任何异常都返回空点位而不是错误页：底图是装饰，缺了它页面照常。
 */
export async function GET(req: Request) {
  const gate = (await cookies()).get(SCRAPE_GATE_COOKIE)?.value;
  if (!verifyGateValue(gate) && !(await isAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const blocked = await guardApiRequest(req, {
    scope: "analytics:visitormap",
    limit: 60,
    windowMs: 60_000,
    blockSuspicious: false,
    checkOrigin: false,
    checkSecFetch: false,
  });
  if (blocked) return blocked;

  try {
    const payload = await getVisitorMapPayload();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch (e) {
    console.warn("[analytics] visitor-map failed:", e);
    return NextResponse.json({
      points: [],
      generatedAt: new Date().toISOString(),
      windowDays: 7,
    });
  }
}
