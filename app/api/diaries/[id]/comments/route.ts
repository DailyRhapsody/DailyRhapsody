import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getClientIpFromRequest } from "@/lib/client-ip";
import {
  addComment,
  COMMENT_AVATAR_COUNT,
  CommentLimitError,
  CommentsUnavailableError,
  isDiaryId,
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
 * 只有日记库里存在的篇目才能评论，私密篇只对站长开放；否则任意 id 都能在 Redis 里开新键。
 * 只读缓存、不触发 Notion 重拉。缓存读不到时无法判断公开与否：访客拒绝，站长照常。
 */
async function diaryAccess(diaryId: string, admin: boolean): Promise<"ok" | "missing" | "unknown"> {
  const diaries = await getCachedDiaries();
  if (!diaries) return "unknown";
  const diary = diaries.find((d) => d.id === diaryId);
  if (!diary || (!diary.isPublic && !admin)) return "missing";
  return "ok";
}

/**
 * 去掉控制字符和不可见的格式字符（零宽、方向控制、软连字符等），保留换行、制表符换成空格，
 * 连续空行压成一个。U+200C / U+200D（波斯文等的连接控制、拼 emoji）和 U+E0020–E007F
 * （苏格兰、威尔士等旗帜 emoji 的标签字符）是正常文字的一部分，不删
 */
function cleanText(s: string, max: number): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    // 标签字符只在「🏴 + 标签 + 结束符」组成的旗帜里保留，单独出现的（可藏隐形文字）删掉
    .replace(/(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E007F}]/gu, (_, flag) => flag ?? "")
    .replace(/(?![\u200c\u200d\u{E0020}-\u{E007F}])\p{Cf}/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** 比较昵称用：兼容字形归一，去掉一切不可见字符和空白，忽略大小写 */
function nameKey(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\s]/gu, "")
    .toLowerCase();
}

// 读评论走批量接口 GET /api/diaries/comments?ids=…（app/api/diaries/comments/route.ts）

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
  if (!isDiaryId(diaryId)) return json({ error: "Invalid id" }, 400);
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
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
  if (access === "unknown" && !admin) return json({ error: "服务暂时不可用，请稍后再试" }, 503);

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
    // 访客不能冒用站长的名字（夹杂不可见字符、全角半角变体也算）
    if (nameKey(author) === nameKey(profile.name)) author = "";
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
    if (e instanceof CommentsUnavailableError) return json({ error: "评论暂不可用" }, 503);
    throw e;
  }
}
