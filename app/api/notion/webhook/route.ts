/**
 * Notion webhook：作者在 Notion 页面评论里新增/编辑/删除评论时，把变化同步回博客。
 *
 * 安全：
 * - 每个请求带 X-Notion-Signature，是对原始请求体的 HMAC-SHA256（密钥是订阅时
 *   拿到的 verification_token）。必须先读原始文本再验签，JSON.parse 后重新序列化
 *   会改变字节，验签必失败。
 * - 订阅创建时 Notion 会发一次带 verification_token 的请求，这类请求没有签名，
 *   直接 ACK 200，token 由作者填回 Notion 页面。
 */
import { NextResponse } from "next/server";
import { handleNotionCommentEvent, verifyNotionSignature } from "@/lib/comment-sync";

export const maxDuration = 60;

/** 评论正文上限 2000 字，加上事件元数据远小于这个值；防止被灌大包 */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  const secret = process.env.NOTION_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 订阅验证请求：只带 verification_token，没有事件结构，也不需要签名
  if (payload && typeof payload === "object" && typeof (payload as { verification_token?: unknown }).verification_token === "string") {
    return NextResponse.json({ ok: true });
  }

  if (!verifyNotionSignature(raw, req.headers.get("x-notion-signature"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const result = await handleNotionCommentEvent(payload);
  // retry 交给 Notion 重投（最多 8 次）；ignored 也回 200，避免无意义重试
  if (result === "retry") {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
