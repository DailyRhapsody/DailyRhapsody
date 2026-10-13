/** 历史分析可能很长；按服务端逐条上限和实际 UTF-8 字节约束普通聊天请求。 */
export function chatRequestBody(history: { role: "user" | "assistant"; content: string }[]): string {
  const messages = history.slice(-16).map(({ role, content }) => ({
    role, content: content.slice(0, role === "user" ? 2_000 : 4_000),
  }));
  const encoder = new TextEncoder();
  let body = JSON.stringify({ messages });
  while (messages.length > 1 && (messages[0].role !== "user" || encoder.encode(body).length > 60 * 1024)) {
    messages.shift();
    body = JSON.stringify({ messages });
  }
  return body;
}
