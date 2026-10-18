import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { deleteComment, getComment, isDiaryId } from "@/lib/comments-store";
import { runInBackground, syncDeletedComment } from "@/lib/comment-sync";
import { withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";

/** 站长删除评论，同时删掉它在 Notion 上对应的那条 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const badOrigin = rejectCrossSiteWrite(req);
  if (badOrigin) return badOrigin;
  if (!(await isAdmin())) {
    return withAntiScrapeHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }
  const { id, commentId } = await params;
  const comment = isDiaryId(id) && commentId ? await getComment(id, commentId) : null;
  const removed = isDiaryId(id) && commentId ? await deleteComment(id, commentId) : false;
  if (removed && comment) {
    runInBackground(() => syncDeletedComment({ ...comment, diaryId: comment.diaryId || id }));
  }
  return withAntiScrapeHeaders(
    NextResponse.json({ ok: removed }, { status: removed ? 200 : 404 })
  );
}
