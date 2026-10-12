/** 只用到 method 与 headers.get，避免把 NextRequest 类型带进这个纯模块。 */
type MinimalRequest = {
  method: string;
  headers: { get(name: string): string | null };
};

/**
 * 请求是否来自浏览器页面导航。
 * 优先看 Sec-Fetch 头（浏览器导航固有，脚本难以伪造完整），缺失时退回 Accept。
 * 接口调用、图片子资源、以及 Accept 为 `*` 或缺失的客户端一律走 JSON。
 */
export function wantsHtml(req: MinimalRequest): boolean {
  if (req.method !== "GET") return false;
  const dest = req.headers.get("sec-fetch-dest");
  const mode = req.headers.get("sec-fetch-mode");
  if (dest === "document" || mode === "navigate") return true;
  if (dest && dest !== "document" && dest !== "empty") return false;
  return (req.headers.get("accept") ?? "").includes("text/html");
}

/**
 * 被封禁 IP 访问页面时返回的中文提示页。
 *
 * 之前这里直接回 JSON（`{"error":"您的 IP 由于异常请求已被暂时限制访问。"}`），
 * 真人撞上时看到的是一段裸 JSON，既不知道发生了什么，也不知道要等多久。
 *
 * 只写用户能据此行动的信息：发生了什么、要等多久、可以做什么。
 * 不写封禁原因、不写内部键名与实现细节。
 *
 * @param remainingSeconds 剩余封禁秒数，0 或未传表示取不到真实时长。
 */
export function blockedPageHtml(remainingSeconds = 0): string {
  const wait =
    remainingSeconds >= 3600
      ? `限制将在约 ${Math.ceil(remainingSeconds / 3600)} 小时后自动解除，届时无需任何操作即可正常访问。`
      : remainingSeconds > 0
        ? `限制将在约 ${Math.max(1, Math.ceil(remainingSeconds / 60))} 分钟后自动解除，届时无需任何操作即可正常访问。`
        : "限制最长 24 小时后自动解除，届时无需任何操作即可正常访问。";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>访问暂时受限</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: linear-gradient(to bottom, #f4f4f5, #ffffff);
    color: #18181b;
    font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 32rem; }
  h1 {
    margin: 0 0 1.25rem;
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  p {
    margin: 0 0 0.9rem;
    font-size: 0.875rem;
    line-height: 1.75;
    color: #52525b;
  }
  p:last-child { margin-bottom: 0; }
  @media (prefers-color-scheme: dark) {
    body { background: linear-gradient(to bottom, #09090b, #000000); color: #fafafa; }
    p { color: #a1a1aa; }
  }
</style>
</head>
<body>
<main>
  <h1>访问暂时受限</h1>
  <p>本站检测到来自当前网络的异常请求，已临时限制访问。</p>
  <p>${wait}</p>
  <p>若正在使用会批量抓取页面的浏览器插件或命令行工具，请先关闭再重试。</p>
</main>
</body>
</html>
`;
}
