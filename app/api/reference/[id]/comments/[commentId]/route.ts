import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  deleteReferenceComment,
  isReferenceThreadId,
} from "@/lib/reference-comments";
import { withAntiScrapeHeaders } from "@/lib/request-guard";
import { rejectCrossSiteWrite } from "@/lib/same-origin";

/** 站长删除 Reference 评论。与日记评论删除互不影响。 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const badOrigin = rejectCrossSiteWrite(req);
  if (badOrigin) return badOrigin;
  if (!(await isAdmin())) {
    return withAntiScrapeHeaders(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
  }

  const { id, commentId } = await params;
  if (!isReferenceThreadId(id) || !/^[0-9a-z-]{1,64}$/i.test(commentId)) {
    return withAntiScrapeHeaders(NextResponse.json({ error: "Invalid id" }, { status: 400 }));
  }

  const removed = await deleteReferenceComment(id, commentId);
  if (!removed) {
    return withAntiScrapeHeaders(NextResponse.json({ ok: false, error: "Not found" }, { status: 404 }));
  }
  return withAntiScrapeHeaders(NextResponse.json({ ok: true }));
}
