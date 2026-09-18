import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { deleteComment, isDiaryId } from "@/lib/comments-store";
import { withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";

/** 站长删除评论 */
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
  const removed = isDiaryId(id) && commentId ? await deleteComment(id, commentId) : false;
  return withAntiScrapeHeaders(
    NextResponse.json({ ok: removed }, { status: removed ? 200 : 404 })
  );
}
