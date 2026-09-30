# DailyRhapsody

个人博客，正式域名 **[tengjun.org](https://tengjun.org)**。

Next.js 16（App Router）+ React 19，内容托管在 Notion，部署在 Vercel。

## 栏目与数据源

内容全部来自 Notion，三个库各自独立，代码里一一对应：

| 栏目 | 路由 | Notion 库 | 环境变量 | 数据层 |
|---|---|---|---|---|
| 日记 | `/blog` | Blog | `NOTION_DATABASE_ID` | `lib/notion.ts` |
| 图片动态 | `/moments` | Moments | `NOTION_GALLERY_DATABASE_ID` | `lib/notion-moments.ts` |
| 收藏 | `/reference` | Reference | `NOTION_REFERENCE_DB_ID` | `lib/notion-reference.ts` |

`/blog` 与 `/moments` 是同一页（`app/blog`）的两个 tab，切换时只改地址栏不重载；`/moments` 由 `next.config.ts` 重写到同一页，显示哪个 tab 由地址决定。旧地址 `/entries`（含 `#entry-…` 锚点）永久跳转到 `/blog`，`/entries?tab=moments` 与 `/the-moment` 永久跳转到 `/moments`。

三个数据层结构一致：Upstash Redis 缓存（stale-while-revalidate + 后台刷新），刷新阈值由 `NOTION_CACHE_STALE_S` 控制，默认 5 分钟；硬 TTL 由 `NOTION_CACHE_TTL` 控制，默认且最低为 48 小时。

Reference 库的字段约定：`Name`(title)、`URL`(url)、`Source`(select)、`Tag`(multi-select)、`Public`(checkbox)、`ClippedAt`(created_time)。**只有勾选 `Public` 的条目才会公开显示。**

Blog 的 `Date` 字段兼容「日期」(`date`) 和「创建时间」(`created_time`)，字段名保留 `Date`。创建时间会保留精确时分秒用于显示、排序及时间轴；热力图日历按 `Asia/Shanghai` 归档，卡片时间沿用浏览器本地时区。手填的纯日期仍保留原日历日。

改成创建时间后，文章时间取 Notion 页面的创建时刻，可能与原来手填的发布日期不同；[Notion API 将该字段定义为系统维护的只读时间戳](https://developers.notion.com/reference/page-property-values)。Webhook 地址、鉴权头和缓存刷新流程不变。自动化应保留「页面新增」触发器，属性更新选择仍可编辑的字段；不要依赖修改只读的 `Date` 触发同步。现有缓存会在下一轮刷新后更新日期。

新建的 Notion 库记得在 `⋯ → Connections` 里授权给 integration，否则 API 读不到。

## 反爬网关

站点数据接口不是裸奔的，`proxy.ts` + `lib/scrape-gate.ts` 实现了一套握手：

1. 访问页面时中间件签发 `dr_seed` cookie（4 段格式 `exp.nonce.ipBucket.sig`，HMAC 绑定 IP bucket，5 分钟有效）
2. 客户端 `GateClient` 读取 nonce，算 PoW（`sha256(nonce + ":" + counter)` 前 N 位为 0）
3. `POST /api/gate/issue` 校验 PoW + `Sec-Fetch-*` 指纹 + 同源，通过后签发 `dr_gate`
4. 受保护接口（`/api/diaries`、`/api/moments`、`/api/reference`、`/api/profile`、`/api/chat`）只认 `dr_gate` 或管理员 session

搜索引擎、RSS 阅读器、社交分享卡片 bot 在 UA 白名单里，不会被拦。

调试接口时注意：`curl` 默认 UA 会被直接拒绝，且缺 `Sec-Fetch-*` 头也过不了握手。

## 本地开发

```bash
npm install
npx vercel env pull .env.local   # 或手动照 .env.example 填
npm run dev
```

打开 http://localhost:3000

日期与缓存回归（Node.js 26，离线运行）：`node --experimental-test-module-mocks --test tests/notion-diary-*.test.mjs`。可分别设置 `TZ=UTC` 和 `TZ=Asia/Shanghai` 核对服务端时区不影响创建时间的日历归属。集成用例模拟 Notion 与 Redis，并禁止真实网络请求。

`next dev` 默认不调用 Notion API（本地与生产共用同一 token 的限流额度），列表只读 Redis 里现有的缓存。确需回源时换用单独的 integration token，并设 `NOTION_ALLOW_DEV_FETCH=1`，见 `.env.example`。本地 `next start` 按生产模式运行，不受这道开关拦截，同样不要用 `vercel env pull` 拉下来的生产 token。

若终端出现 **`Failed to open database` / `invalid digit found in string`**，是 **Turbopack 本地缓存**损坏（与数据库无关）。执行 `npm run clean:next` 后重跑，或直接用 **`npm run dev:webpack`** 走 Webpack。

## 部署

Vercel 项目 `dailyrhapsody` 已连接本仓库的 Git 集成：

- push 到 `main` → 自动生产部署
- push 功能分支 → 自动 preview 部署

**不要手动跑 `vercel --prod`。** CLI 直传会打包当前工作区（含未提交的文件），并把本地 HEAD 的 commit 信息伪装成部署 meta，结果是线上跑着仓库里不存在的代码 —— 这个坑真踩过一次，线上多了个仓库里没有的栏目，持续了 80 天。

判断某次部署的真实来源只能看 API 的 `source` 字段（`git` / `cli`），meta 里的 `githubCommitRef` 不可信。

## 按需刷新缓存

secret 只能走请求头（`Authorization: Bearer <secret>` 或 `X-Revalidate-Secret: <secret>`），不能放 query string（避免落入访问日志、Referer、浏览器历史）；且仅接受 POST：

```bash
curl -X POST -H "Authorization: Bearer $REVALIDATE_SECRET" \
     https://www.tengjun.org/api/revalidate
```

会把三个栏目的 Notion 缓存标记为过期（保留旧数据，下一次访问时后台重拉）并重新验证页面缓存。

Notion 数据库自动化的配置：触发条件选页面新增 / 属性修改（改正文不会触发），动作选 Send webhook，URL 填 `https://www.tengjun.org/api/revalidate`（带 www，裸域会 308 跳转），在 Add custom header 里加 `X-Revalidate-Secret`。

## 其他

- 环境变量清单见 [`.env.example`](./.env.example)
- 自定义域名 / Cloudflare 边缘防护：[docs/custom-domain-cloudflare.md](./docs/custom-domain-cloudflare.md)
- 后台 Markdown 的 AI 辅助（可选，需 `OPENAI_API_KEY`）：[docs/ai-assistant.md](./docs/ai-assistant.md)
- 右下角 AI 数字人（默认关闭，`NEXT_PUBLIC_PET_MODE` 控制）：[docs/pet-digital-twin.md](./docs/pet-digital-twin.md)

## 关于存储

内容源已全部迁到 Notion，**不需要 PostgreSQL**。访客统计（`lib/analytics-store.ts`）存在 Upstash Redis，与缓存、限流同库；没有 KV 凭证时只在本地开发写 `data/analytics-visits.jsonl`。
