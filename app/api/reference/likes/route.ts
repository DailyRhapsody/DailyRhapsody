import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getCachedReferenceItems, getReferenceItems, isReferenceConfigured } from "@/lib/notion-reference";
import {
  getReferenceLikes,
  isReferenceLikesConfigured,
  readLikeDeviceId,
} from "@/lib/reference-likes";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";

const MAX_IDS = 30;
const PAGE_ID_RE = /^[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return withAntiScrapeHeaders(NextResponse.json(body, { status }));
}

export async function GET(req: Request) {
  const blocked = await guardApiRequest(req, {
    scope: "reference:likes:list",
    limit: 60,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  if (!isReferenceConfigured() || !isReferenceLikesConfigured()) {
    return json({ likes: {} }, 503);
  }

  const ids = [
    ...new Set(
      (new URL(req.url).searchParams.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => PAGE_ID_RE.test(s)),
    ),
  ].slice(0, MAX_IDS);

  if (ids.length === 0) return json({ likes: {} });

  // 只给公开条目出数；私密条目连计数都不外泄。列表缓存缺失时回源一次，
  // 与 /api/reference 同策略，避免首屏点赞数永远是 0。
  const [admin, cached] = await Promise.all([isAdmin(), getCachedReferenceItems()]);
  const items = cached ?? (await getReferenceItems());
  const visible = new Set(
    items.filter((item) => admin || item.isPublic).map((item) => item.id),
  );
  const allowed = ids.filter((id) => visible.has(id));

  const deviceId = readLikeDeviceId(req.headers.get("cookie"));
  const likes = await getReferenceLikes(allowed, deviceId);
  return json({ likes });
}
