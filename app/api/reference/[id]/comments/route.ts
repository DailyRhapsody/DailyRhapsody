import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import { getCachedReferenceItems, isReferenceConfigured } from "@/lib/notion-reference";
import { getProfile } from "@/lib/profile-store";
import {
  addReferenceComment,
  isReferenceCommentsConfigured,
  isReferenceThreadId,
  REFERENCE_COMMENT_AVATAR_COUNT,
  ReferenceCommentLimitError,
  ReferenceCommentsUnavailableError,
} from "@/lib/reference-comments";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";
import { limitByIp } from "@/lib/upstash-rate-limit";

const MAX_AUTHOR = 32;
const MAX_CONTENT = 1000;

function json(body: unknown, status = 200) {
  return withAntiScrapeHeaders(NextResponse.json(body, { status }));
}

/** 去掉控制字符与不可见格式字符；保留换行，制表符转空格，连续空行压成一个。 */
function cleanText(s: string, max: number): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E007F}]/gu, (_, flag) => flag ?? "")
    .replace(/(?![\u200c\u200d\u{E0020}-\u{E007F}])\p{Cf}/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function nameKey(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\s]/gu, "")
    .toLowerCase();
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const badOrigin = rejectCrossSiteWrite(req);
  if (badOrigin) return badOrigin;

  const blocked = await guardApiRequest(req, {
    scope: "reference:comments:create",
    limit: 10,
    windowMs: 60_000,
    blockSuspicious: false,
  });
  if (blocked) return blocked;

  if (!isReferenceConfigured()) return json({ error: "Reference DB is not configured" }, 503);
  if (!isReferenceCommentsConfigured()) return json({ error: "评论暂不可用" }, 503);

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "需要 JSON 请求" }, 415);
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 8 * 1024) return json({ error: "Payload too large" }, 413);

  const { id } = await params;
  if (!isReferenceThreadId(id)) return json({ error: "Invalid id" }, 400);

  let body: { author?: unknown; content?: unknown; avatar?: unknown; website?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid body" }, 400);
  }
  // 蜜罐字段：真人看不见，脚本按字段名填了就拒收
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ error: "Invalid body" }, 400);
  }

  const content = cleanText(typeof body.content === "string" ? body.content : "", MAX_CONTENT);
  if (!content) return json({ error: "内容不能为空" }, 400);

  const [admin, items] = await Promise.all([isAdmin(), getCachedReferenceItems()]);
  if (!items && !admin) return json({ error: "服务暂时不可用，请稍后再试" }, 503);
  const item = (items ?? []).find((x) => x.id === id);
  if (!item || (!admin && !item.isPublic)) return json({ error: "条目不存在" }, 404);

  if (!admin && !(await limitByIp("reference:comments:create:day", getClientIpFromRequest(req), 40, "1 d"))) {
    return json({ error: "今天评论太多了，明天再来吧" }, 429);
  }

  const profile = await getProfile();
  let author: string;
  let avatar: number | undefined;
  if (admin) {
    author = profile.name;
  } else {
    author = cleanText(typeof body.author === "string" ? body.author : "", MAX_AUTHOR).replace(/\s+/g, " ");
    // 访客不能冒用站长名字（夹杂不可见字符、全角半角变体也算）
    if (nameKey(author) === nameKey(profile.name)) author = "";
    author ||= "匿名";
    const a = Number(body.avatar);
    avatar =
      Number.isInteger(a) && a >= 1 && a <= REFERENCE_COMMENT_AVATAR_COUNT
        ? a
        : 1 + Math.floor(Math.random() * REFERENCE_COMMENT_AVATAR_COUNT);
  }

  try {
    const comment = await addReferenceComment({
      threadId: id,
      author,
      content,
      ...(admin ? { isAuthor: true } : { avatar }),
    });
    return json(comment);
  } catch (e) {
    if (e instanceof ReferenceCommentLimitError) return json({ error: "这条的评论已满" }, 409);
    if (e instanceof ReferenceCommentsUnavailableError) return json({ error: "评论暂不可用" }, 503);
    throw e;
  }
}
