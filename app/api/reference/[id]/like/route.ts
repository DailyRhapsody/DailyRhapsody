import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import {
  getCachedReferenceItem,
  getReferenceItems,
  isReferenceConfigured,
} from "@/lib/notion-reference";
import {
  mintLikeCookie,
  newLikeDeviceId,
  readLikeDeviceId,
  setReferenceLike,
} from "@/lib/reference-likes";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";
import { limitByIp } from "@/lib/upstash-rate-limit";

const PAGE_ID_RE = /^[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return withAntiScrapeHeaders(
    NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } }),
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const badOrigin = rejectCrossSiteWrite(req);
  if (badOrigin) return badOrigin;

  const blocked = await guardApiRequest(req, {
    scope: "reference:like",
    limit: 60,
    windowMs: 60_000,
    blockSuspicious: false,
  });
  if (blocked) return blocked;

  if (!isReferenceConfigured()) return json({ error: "Reference DB is not configured" }, 503);

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "需要 JSON 请求" }, 415);
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 1024) return json({ error: "Payload too large" }, 413);

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid body" }, 400);
  }
  if (body?.action !== "like" && body?.action !== "unlike") {
    return json({ error: "Invalid action" }, 400);
  }

  const { id } = await params;
  if (!PAGE_ID_RE.test(id)) return json({ error: "Not found" }, 404);

  const [admin, cached] = await Promise.all([isAdmin(), getCachedReferenceItem(id)]);
  const item = cached ?? (await getReferenceItems()).find((x) => x.id === id);
  if (!item || (!admin && !item.isPublic)) return json({ error: "Not found" }, 404);

  if (!admin && !(await limitByIp("reference:like:day", getClientIpFromRequest(req), 50, "1 d"))) {
    return json({ error: "今天点赞太多了，明天再来吧" }, 429);
  }

  const existing = readLikeDeviceId(req.headers.get("cookie"));
  const deviceId = existing ?? newLikeDeviceId();
  const state = await setReferenceLike(id, deviceId, body.action);
  if (!state) return json({ error: "点赞暂不可用" }, 503);

  const res = NextResponse.json(state, {
    headers: { "Cache-Control": "private, no-store" },
  });
  // 续期：did 不变，只重签，避免 1 年后全部身份漂移
  res.headers.append("Set-Cookie", mintLikeCookie(deviceId));
  return withAntiScrapeHeaders(res);
}
