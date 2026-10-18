# 评论双向同步

博客的文章评论与 Notion 页面评论保持双向同步：访客在博客发的评论会出现在对应文章的 Notion 页面评论里，作者在 Notion 页面评论里新增、编辑、删除的评论也会同步回博客。

## 数据流

```text
访客在 /blog 发评论
  └─ 写 Upstash dr:comments:<diaryId>（立即返回给访客）
       └─ 后台任务 POST /v1/comments 到对应文章页面
            └─ 成功：把 notionCommentId 回写评论记录
            └─ 失败：进 dr:comment-sync:pending，读评论时顺带重试（10 分钟限频），每日预热兜底

作者在 Notion 页面评论里操作
  └─ Notion webhook → POST /api/notion/webhook
       ├─ 验签 → 事件去重 → 只认 person 白名单
       ├─ comment.created → GET /v1/comments/{id} → 写入 Upstash（isAuthor）
       ├─ comment.updated → 更新博客评论正文
       └─ comment.deleted → 删除博客评论
```

## Notion 侧配置（一次性）

1. 打开 <https://app.notion.com/developers/connections>，选中 `DailyRhapsody` 这个 connection。
2. 进入 **Webhooks** 标签，点 **+ Create a subscription**。
3. Webhook URL 填 `https://tengjun.org/api/notion/webhook`。
4. 事件勾选 `comment.created`、`comment.updated`、`comment.deleted` 三个。
5. 创建后 Notion 会向该 URL 发一个带 `verification_token` 的请求。端点会直接回 200，token 不会自动保存；到订阅页面点 **Resend token**，把收到的 token 值填进 Notion 的验证框。
6. 同一个 token 写入环境变量 `NOTION_WEBHOOK_SECRET`（Production / Preview / Development 各一份），本地 `.env.local` 同步一份。
7. **必填** `NOTION_OWNER_USER_ID`：作者本人的 Notion 用户 id。不配置时反向同步会直接忽略所有事件，避免工作区里任意成员或集成冒充作者写进博客。

   获取方式：任取一篇自己的文章，调 `GET /v1/pages/{page_id}`，响应里的 `last_edited_by.id` 就是本人；也可以先不配，等自己在 Notion 页面评论里回一条，从 webhook 事件的 `authors[0].id` 里读出来。`/v1/users` 在 bot 视角下只返回 bot，拿不到成员列表，不能靠它推断。

## Redis 键

| 键 | 说明 |
| --- | --- |
| `dr:comment-notion:<notionCommentId>` | 映射到博客评论 id；评论删除后写 `deleted` 占位，保留 30 天，防止旧事件把评论复活 |
| `dr:notion-event:<event.id>` | 事件级去重，保留 24 小时（Notion 同一事件最多重试 8 次） |
| `dr:comment-sync:pending` | 待补任务（ZSET，score 为下次重试时间）；读评论时顺带处理最多 10 条（10 分钟限频），每日预热任务兜底 20 条 |

## 行为边界

- 只处理**页面级**评论（`data.parent.type === "page"`）。作者在某段正文上做的块级评论会被忽略并记日志。
- 只认 `person` 且在白名单里的账号。bot 事件就是我们自己同步过去的评论，必须忽略，否则会循环。
- Notion 评论的发表者显示为 integration（DailyRhapsody），不是访客昵称；昵称写在正文开头（`昵称：内容`）。
- 每条评论一个 Notion 页面评论。数量大时 Notion 页面右侧的气泡会很密，这是 Notion 自身的展示方式。
- 不做图片评论。

## 故障排查

| 现象 | 先看 |
| --- | --- |
| 博客评论没出现在 Notion | `dr:comment-sync:pending` 里有没有该评论；`NOTION_TOKEN` 是否有效；Notion 是否限流（3 请求/秒） |
| Notion 回复没出现在博客 | Notion 订阅是否包含 `comment.created`；`NOTION_WEBHOOK_SECRET` 是否与订阅一致；`NOTION_OWNER_USER_ID` 是否指向作者本人 |
| webhook 一直 401 | 验签失败：检查是否用原始 body 验签、密钥是否配到了对应的 Vercel 环境 |
| 同一条评论出现两次 | 事件去重键被清过；检查 `dr:notion-event:*` 的 TTL 与写入 |
| 删除 Notion 评论后博客还在 | 删除事件未订阅，或映射键已过期（30 天） |

## 测试

```bash
node --experimental-test-module-mocks --test tests/comment-sync.test.mjs
```

测试覆盖验签、bot 过滤、白名单、事件级幂等、映射幂等、created/updated/deleted 三种事件、正向创建与失败入队、删除同步、待补重试。四个关键守卫做过突变验证：去掉 bot 过滤、白名单、事件幂等、映射幂等，对应测试都会变红。
