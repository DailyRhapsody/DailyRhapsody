import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import {
  addComment,
  COMMENT_AVATAR_COUNT,
  CommentLimitError,
  getComments,
} from "@/lib/comments-store";
import { getCachedDiaries } from "@/lib/notion";
import { getProfile } from "@/lib/profile-store";
import { guardApiRequest, withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";
import { limitByIp } from "@/lib/upstash-rate-limit";

const MAX_AUTHOR = 32;
const MAX_CONTENT = 2000;

function json(body: unknown, status = 200) {
  return withAntiScrapeHeaders(NextResponse.json(body, { status }));
}

/**
 * 只有日记库里存在的篇目才能读写评论，私密篇只对站长开放；否则任意 id 都能在 Redis 里开新键。
 * 只读缓存、不触发 Notion 重拉。缓存缺失（冷启动）时读放行、写拒绝。
 */
async function diaryAccess(diaryId: string, admin: boolean): Promise<"ok" | "missing" | "unknown"> {
  const diaries = await getCachedDiaries();
  if (!diaries) return "unknown";
  const diary = diaries.find((d) => d.id === diaryId);
  if (!diary || (!diary.isPublic && !admin)) return "missing";
  return "ok";
}

/** 去掉控制字符与零宽 / 方向控制符（保留换行，制表符换成空格），连续空行压成一个 */
function cleanText(s: string, max: number): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = await guardApiRequest(req, {
    scope: "comments:list",
    limit: 40,
    windowMs: 60_000,
  });
  if (blocked) return blocked;
  const { id: diaryId } = await params;
  if (!diaryId) return json({ error: "Invalid id" }, 400);
  if ((await diaryAccess(diaryId, await isAdmin())) === "missing") {
    return json({ error: "Not found" }, 404);
  }
  return json(await getComments(diaryId));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const badOrigin = rejectCrossSiteWrite(req);
  if (badOrigin) return badOrigin;
  const blocked = await guardApiRequest(req, {
    scope: "comments:create",
    limit: 6,
    windowMs: 60_000,
    blockSuspicious: false,
  });
  if (blocked) return blocked;
  const { id: diaryId } = await params;
  if (!diaryId) return json({ error: "Invalid id" }, 400);
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > 8 * 1024) {
    return json({ error: "Payload too large" }, 413);
  }
  let body: { author?: unknown; content?: unknown; avatar?: unknown; website?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid body" }, 400);
  }
  // 蜜罐字段：表单里对真人不可见，脚本按字段名填了就拒收
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ error: "Invalid body" }, 400);
  }
  const content = cleanText(typeof body.content === "string" ? body.content : "", MAX_CONTENT);
  if (!content) return json({ error: "内容不能为空" }, 400);

  const admin = await isAdmin();
  const access = await diaryAccess(diaryId, admin);
  if (access === "missing") return json({ error: "文章不存在" }, 404);
  if (access === "unknown") return json({ error: "服务暂时不可用，请稍后再试" }, 503);

  // 单 IP 每天上限：分钟级限流挡不住慢速刷屏
  if (!admin && !(await limitByIp("comments:create:day", getClientIpFromRequest(req), 40, "1 d"))) {
    return json({ error: "今天评论太多了，明天再来吧" }, 429);
  }

  const profile = await getProfile();
  let author: string;
  let avatar: number | undefined;
  if (admin) {
    author = profile.name;
  } else {
    author = cleanText(typeof body.author === "string" ? body.author : "", MAX_AUTHOR).replace(/\s+/g, " ");
    // 访客不能冒用站长的名字
    if (author.toLowerCase() === profile.name.trim().toLowerCase()) author = "";
    author ||= "匿名";
    const a = Number(body.avatar);
    avatar =
      Number.isInteger(a) && a >= 1 && a <= COMMENT_AVATAR_COUNT
        ? a
        : 1 + Math.floor(Math.random() * COMMENT_AVATAR_COUNT);
  }

  try {
    const comment = await addComment({
      diaryId,
      author,
      content,
      ...(admin ? { isAuthor: true } : { avatar }),
    });
    return json(comment);
  } catch (e) {
    if (e instanceof CommentLimitError) return json({ error: "这篇的评论已满" }, 409);
    throw e;
  }
}
