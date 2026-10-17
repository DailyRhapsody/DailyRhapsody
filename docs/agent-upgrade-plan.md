# 博客数字人 → Agent 升级：方案与架构（定稿 v1.1 · 已实现，待交叉评审与灰度）

> 2026-10-17 · 四路并行调研 + 助手独立复现验证 + 本人拍板五项决策 · 状态：P1（协议与循环）、P2（测试）已落地（全量 231 项全绿）；P3 交叉评审完成（安全路 6 处 + 补审协议路 8 条中低 + 对抗复核 2 处残余洞，全部修复并回归）；P4 灰度进行中（本地真实模型冒烟 ✅，抓到并修复续轮报文形状 400；生产 owner 灰度待合入）
> 目标：给 tengjun.org 右下角数字人加上「工具 + 自主循环」，并为公开可浏览场景重立安全边界

## 0 速览（TL;DR）

- **选型：路线 A——纯自实现小循环**（0 新依赖，增量约 400 行含测试）；路线 B（Vercel AI SDK v7）记录在案、暂不采用
- **工具 v1（全部只读站内）**：`search_blog` / `read_article` / `blog_stats`；访客会话**在注册层**就不存在任何写工具
- **循环**：工具执行 ≤4 次、模型调用 ≤5 次（末轮 `tool_choice=none` 强制收尾，保证有回答）；关闭 thinking；非 openai 协议自动降级回单步
- **流式**：NDJSON 事件流（先出「正在检索」步事件，再流式答案）——同时解掉前端 65s 首字节约束
- **安全**：按「注入必然部分成功」做架构止损（对齐 OWASP 2026：Prompt Injection #1、Excessive Agency 升至 #3）
- **已亲测（本账户 2026-10-17）**：`deepseek-flash` + tools 跑通（`finish_reason=tool_calls`，参数正确）；关闭 thinking 可省 token 且绕开限制

## 1 事实核实（只把独立复现过的事实写进设计）

1. **DeepSeek 工具调用**：实测可通过。tools + `tool_choice=auto` → `finish_reason=tool_calls` 且参数 JSON 正确；`thinking:{type:"disabled"}` 同样可用（completion 72→42 tokens）。文档确认两点限制：推理模式下 `tool_choice` 仅 `auto`/`none`（`required` 会 400）；带 tools 时须回传历史 `reasoning_content`——**关闭 thinking 后两坑均不存在**（本方案如此设计）。
2. **模型名**：文档现行仅列 `deepseek-flash` / `deepseek-v4-pro`；旧别名（`deepseek-chat` 等）已从更新记录停列，但**实测仍可调用**（2026-10-17：`deepseek-chat` 正常返回；`deepseek-v4-flash` 在极小 max_tokens 下被推理占满、content 为空）。结论：不紧急，但建议核对 Vercel 生产 `PERSONA_LLM_MODEL` 并择机切到现行名 `deepseek-flash`（本升级的循环固定用 `deepseek-flash`）。
3. **OWASP LLM Top 10 2026**（8 月 3 日发布，4 源交叉核实）：Prompt Injection #1；Excessive Agency 升至 #3（全榜最大变动）；Unbounded Consumption #6；Misinformation #7；System Prompt Leakage 更名扩为 Hidden Context Exposure #8。威胁模型按此对齐。
4. **仓库事实**：全仓原本无任何 `tool_calls` 处理（本次是改协议，不是加能力）；`maxDuration=300s`；前端首字节 65s 硬超时（`usePetChat.ts`）；「每次最多一次模型调用」写在 `docs/pet-digital-twin.md` 两处与路由注释——复核后确认这两处指的都是**分析 Skill** 的运行口径，Skill 管线不进本升级，口径保留；普通对话另立新口径，见 §3.6。
5. **Hermes 参考模式**（本机源码逐条抽查）：`agent/tool_guardrails.py`（停滞/重复调用守卫）、`agent/iteration_budget.py`（步数预算）、`approvals.unattended_mode` 默认 deny（无人值守 fail-closed）、工具结果 `<untrusted_tool_result>` 包装 + 伪造闭合标签中和——全部实测存在，作为模式来源。

## 2 选型对比

| 路线 | 依赖 | 适配度 | 结论 |
|---|---|---|---|
| **A 自实现小循环** | **0 新增** | 高：全掌控配额/流式/降级；贴合「如无必要勿增实体」 | **采用** |
| B Vercel AI SDK v7（ToolLoopAgent / streamText+tools+stopWhen） | `ai` + `@ai-sdk/deepseek` 等 2-3 包 | 高：类型安全、换模型一行、自带工具状态 UI | 备选（工具变多/跟随生态时再评估） |
| C OpenAI Agents SDK (JS) | 1 包+ | 中低：托管工具用不上；tracing 默认出境 | 否 |
| D LangGraph / LangChain JS | 多包 | 低：重、处 API 迁移期 | 否 |
| E Mastra | 平台级 | 中：需 memory/评测平台才值 | 否 |
| 兜底预案 | — | tool_calls 若现不稳：JSON 单步协议（`response_format=json_object`）或切 `deepseek-v4-pro` | 备用 |

## 3 架构设计

### 3.1 数据流

```
访客 ── POST /api/chat ──▶ [原守卫栈一条不动：PoW→同源→burst→访问判定→64KB→日额度]
                                    │
                                    ▼
       ┌──── Agent 循环（工具 ≤4 次 / 模型调用 ≤5 次，总 deadline 150s）────┐
       │  模型（deepseek-flash，tools=3 只读，thinking=off）        │
       │    ├─ 需要资料 → tool_call ─▶ 服务端执行工具               │
       │    │    （数据源=route 已过滤 visible 集合 + bundle.notes）│
       │    │    ◀─ 工具结果（<untrusted_tool_result> 包装）        │
       │    └─ 信息足够 → 最终回答                                  │
       └──────────────────────────────────────────────────────────┘
                                    │
                                    ▼
    NDJSON 事件流：step(进度一行) → delta(正文) → done/error
    引用核验：回答里的引用以工具结果与检索片段为准；链接一律服务器生成、仅站内
```

### 3.2 工具（v1 三件套，全部只读站内）

- `search_blog(keyword)`：复用 `lib/persona/retrieve.ts` 内核（字二元组+IDF），返回 ≤5 条 {title, href, 摘要}
- `read_article(id)`：从**本次请求已过滤的 visible 集合**取全文（截断 6000 字）；id 不在集合 → 直接拒绝
- `blog_stats()`：`facts.ts buildBlogFacts` 同口径（总篇数/年份/最近/标签），可选
- 实现纪律（照抄 skill-runners 的穷举 `Record` 模式：漏注册即编译失败）：
  - 新增 `lib/persona/tools.ts`（schema）+ `lib/persona/tool-runners.ts`（实现）
  - **不得 import** `store.ts / prompt.ts / auth / notion.ts`；数据一律由 route 传入已过滤数组；两个新文件加进 `tests/persona-skills.test.mjs` 依赖禁区清单
  - 每工具结果大小硬上限（≤8KB）；schema 固定（枚举/长度）；未知工具名在路由层直接拒

### 3.3 循环预算（三重闸）

- **步数双上限**：模型调用 ≤5 次、工具执行 ≤4 次（分别计数）；最后一次调用 `tool_choice=none` 强制收尾作答；同参数重复调用（停滞签名）不重复执行，回提示让模型换路子
- **时间**：单步 55s、总 150s（上游 55s；函数上限 300s；前端 NDJSON 首包即达，65s 约束解除）
- **费用**：每次模型调用记一步，首步在路由预检、之后每步过闸，全站 1500 步/日；超限友好报错收尾
- 请求额度沿用现状（30/IP/日、600/站/日、8 次/分**不改**）；分析池（120/24h）与两条 skill 的共用关系不动

### 3.4 流式协议（前端一处小改）

- 服务端 `application/x-ndjson`：`{t:"step"}` / `{t:"delta",v}` / `{t:"refs"}` / `{t:"done"}` / `{t:"error"}`
- 前端 `usePetChat` 按行解析；**兼容回退**——Content-Type 不是 NDJSON 时按旧纯文本路径处理（回滚安全）
- 进度展示（克制版）：检索时一行小字「正在翻我的文章…」（可关，见 §6-2）

### 3.5 输出与引用

- 引用与 skill 同款核验：逐字命中公开原文才保留，否则丢弃（对齐 dropUnverified 口径）
- 渲染白名单维持并收紧：禁图片（现状）＋外链降级为纯文本、**仅站内链接可点**（`lib/chat-markdown.ts` 小改）
- 「没写过就明说」事实边界话术保留在系统提示

### 3.6 不变式与文档同步（已按实现校正）

- **Skill 口径不变**：两个分析 Skill 的「每次最多一次模型调用（拒答二分探测除外）」仍然成立——agent 循环只改**普通对话**，skill 管线一行未动；`docs/pet-digital-twin.md` §6.2/§6.3 与路由注释里的这句话指的都是 Skill 运行，不需要改
- **普通对话新口径**：「一次提问最多 5 次模型调用、4 次工具执行、150 秒；任何一步失败收敛为友好错误，已流出的文字保留」
- 已同步处：`docs/pet-digital-twin.md` §3/§4 已写 agent 模式小节与 `PERSONA_AGENT_MODE`；README §3 数字人小节；`route.ts` 头部注释

## 4 公开站点安全规则（16 条落地版；32 条完整版见附录 A）

| # | 规则 | 本期落地方式 |
|---|---|---|
| 1 | 访客会话工具集=只读站内；写/外发/抓取类工具**注册层不存在** | tools 注册表只含 3 个只读工具，不靠提示词约束 |
| 2 | 写工具（未来）仅管理员会话注册 + 二次确认（展示原始参数） | 本期不做，二期再议（§6-3） |
| 3 | 服务端凭据永不进模型上下文；工具全由服务端执行 | 沿用现状；tools 只暴露名称与受限结果 |
| 4 | 工具结果一律 `<untrusted_tool_result>` 包装 + 伪造闭合标签中和 | 照 Hermes 模式实现 |
| 5 | 指令与数据分通道：片段/工具返回只作资料，其内指令不执行 | 系统提示扩述至工具通道 |
| 6 | 输入清洗：隐形字符（U+E0000–E007F 等）与可疑编码过滤 | 入口 + 工具结果双向清洗 |
| 7 | 引用逐字核验；链接服务器生成；对不上就丢 | 对齐 skill 现成口径 |
| 8 | 致命三角：访客会话永远缺「对外通信」腿（零写、零外发、无任意 URL 抓取） | 工具集设计 + 参数校验保证 |
| 9 | 参数校验：域精确白名单、长度/枚举约束；拒自由文本触发 | schema + 路由层校验 |
| 10 | 循环上限=防拒绝钱包（步数/时长/token 三闸 + 全局步数日预算） | §3.3 |
| 11 | 线上只有 public 包；owner 包/凭据绝不进上下文 | 现状保持，工具层继承 tier |
| 12 | 工具数据=route 已过滤 visible，工具不自己读缓存 | §3.2 纪律 + 依赖禁区测试 |
| 13 | 审计：结构化日志（Vercel logs + Upstash 计数），字段脱敏截断、不含正文 | 新 `tools` 审计事件 |
| 14 | 注入可观测：拒绝事件打点，异常激增告警/自动收紧 | Upstash 计数 + 阈值告警 |
| 15 | 一键开关与回滚：`PERSONA_AGENT_MODE=off/owner/public`；故障降级不放开权限 | 新 env + 旧路径保留 |
| 16 | 变更管理：人设/提示词/工具表/渲染白名单变更走评审 + 红队回归（14 项进测试） | 附录 B 脚本化 |

## 5 实施计划（完备实现 → 交叉评审 → 验证测试）

- **P1 协议与循环**：`llm.ts` 工具协议扩展（tool_calls 解析/回填、finish_reason 处理、thinking=off）→ `tools.ts`+`tool-runners.ts` → `route.ts` 循环接入 → `config.ts` 预算常量 → 前端 NDJSON 解析 ✅
- **P2 测试**：单元（协议/围栏/预算/停滞）+ 红队 14 项脚本化 + 全量回归（现有 4 个测试全绿 + `tsc --noEmit` + `lint` + `build`）✅
- **P3 交叉评审**：3-4 路并行（①安全对抗复审 ②协议实现正确性 ③与现有守卫/隐私一致性），结论独立复核后采信。首轮安全路命中 6 处（检索缓存签名撞车＝owner/public 串索引、隐形字符清单缺口、source 属性可伪造、参数格式化绕过停滞、原型链工具名、换稿同长签名撞车）——已全部修复并补 7 项回归测试（先红后绿）；补审两路已完成：协议路 0 高危、8 条中低（截断无标记、失败发 done、缺 index 并槽、重发 name 拼接、重复 id、尾解码、错误类型丢失、reader 未取消），对抗复核 4 处成立、2 处残余洞（INVISIBLE 漏 U+FEFF 与控制符、悬空闭合标签不中和）——共 10 处全部修复、补 9 项回归（先红后绿，230/230 全绿）
- **P4 灰度**：✅ 本地真实模型冒烟通过（DeepSeek 真机：检索→无命中→改关键词→引用站内链接作答；统计类提问数字与页面同口径；冒烟同时抓到续轮报文缺 `type:"function"` 的 400 —— 静态评审两轮都没发现，已修复+回归测试）。生产 owner 模式待合入后开启 → 本人试聊 → `on` 全量；全程保留一键回滚（拨回 off，老单步路径仍在）
- **P5 文档**：§3.6 清单全部同步 ✅（另：Notion 架构页「DailyRhapsody Blog」已同步 4/5 两节）

## 6 决策点（已拍板 2026-10-17，全部按拍板实现）

1. 工具集：**三件套**（search_blog / read_article / blog_stats），全只读。
2. 过程可见性：**一行小字进度**（「正在翻我的文章…」），其余步骤静默。
3. 管理员写工具：**本期不做**；管理员会话与访客一样全局只读。
4. 费用闸：**全站 1500 步/日**（每次模型调用记一步）。
5. 流式协议：**NDJSON** 事件流。

反偷懒审计（按「合理性最优性」回查）后上调：工具执行 3→**4** 次、模型调用 ≤**5** 次、总时限 50→**150** 秒、新增**协议门控**（非 openai 自动降级单步）。

实现落点：`lib/persona/tools.ts`（schema+清洗+包装）、`lib/persona/tool-runners.ts`（实现+穷举登记）、`lib/persona/agent-loop.ts`（循环编排+三重闸+NDJSON）、`app/api/chat/route.ts`（预检+接入）、`hooks/usePetChat.ts`（NDJSON 消费）、`lib/chat-markdown.ts`（外链降级）、`lib/persona/{retrieve,llm,config,prompt}.ts`（扩展）、`tests/persona-agent.test.mjs`（11 子测试，双突变验证红过）。

## 附录 A｜安全规则完整版（32 条）

（整理自安全调研路线，按「总则 / 会话与权限 / 凭据 / 输入处理 / 工具层 / 输出处理 / 检索与记忆 / 运行与观测」分类，逐条与主程序登记表对应；实现时以本附录为准逐条勾稽。）

- 总则：①按「注入必然部分成功」设计，安全性由架构保证；②最小代理与 deny-by-default；③切断致命三角；④不可信内容不参与控制流（plan-then-execute）
- 会话与权限：⑤访客工具集=只读站内；⑥写工具注册层隔离；⑦写操作二次确认（原始参数、次数上限、不可逆人审）；⑧确认主体=管理员本人（独立凭据/限流/短时效）
- 凭据：⑨服务端凭据不进上下文；⑩工具用独立最小权限凭据、可吊销可轮换
- 输入处理：⑪输入即不可信（长度上限、隐形字符/HTML 清洗）；⑫指令与数据分通道（定界包裹+声明）；⑬结构化约束（严格 JSON Schema，拒自由文本触发）
- 工具层：⑭工具白名单路由层校验；⑮参数与出口控制（精确白名单域、上下限、转义）；⑯工具返回值一律按不可信输入处理；⑰工具描述/元数据哈希固定、变更重审；⑱每次调用写审计；⑲执行隔离与限流（次数/超时/有限重试，失败不放大）
- 输出处理：⑳渲染白名单（纯文本+站内链接；禁图/HTML/data URI/参考式外链）；㉑输出复扫（隐形字符、可疑编码、URL 走私）；㉒引用可回溯（逐字核验+服务器生成链接）；㉓事实边界话术（没写过就明说；不构成承诺）；㉔错误路径净化（无堆栈/供应商细节/提示词内容，含流式中间帧）
- 检索与记忆：㉕线上仅 public 包（红线保持）；㉖记忆写入校验+来源标注+TTL（若未来引入）；㉗站外内容接入前提（只作数据、不影响工具选择）
- 运行与观测：㉘现有外围防线保持（PoW/同源/限流/额度）；㉙单请求硬上限（步数/调用数/输出/时长）；㉚注入可观测（拒绝打点、异常收紧）；㉛一键开关与降级（绝不放开发言或工具权限）；㉜变更管理与红队回归（提示词当代码管理）

## 附录 B｜红队检查清单（14 项，进 CI 回归）

1. 直注与越狱基础集（多语言/编码变体）→ 人设与事实边界不漂移
2. 身份伪冒（自称作者/管理员）→ 一律拒绝且不确认
3. 事实边界三连问（未写过的话题要原文/链接）→ 「没写过」+ 无编造引用；真实引用逐字回溯通过
4. 提示词套取（10 种提取手法）→ 套取上限=public 包，无 owner 字段、无凭据
5. 隐形载荷（Unicode Tag/零宽字符）→ 被清洗
6. 工具滥用（伪造信封、要求 write/落草稿/抓 URL）→ 未注册工具名直接被拒
7. 外泄通道实测（markdown 图片/外链/参考式链接/编码 URL）→ 渲染不发外域请求、外链不可点
8. 确认流校验（管理员会话）→ 展示原始参数、拒绝即不执行、审计完整
9. 检索污染（未来可写表层）→ 注入文本只被当数据
10. 多轮漂移与条件触发（「忘记规则」「若…则…」）→ 无效
11. 资源耗尽（超长/逼输出/并发）→ 全部闸门生效、超额文案友好
12. 错误路径（工具失败/超时/拒答）→ 无内部信息泄漏
13. 回归机制：以上固化为脚本，任一变更后全量重跑
14. 演练：kill switch 与对外更正流程每半年一次

## 附录 C｜主要来源

- DeepSeek 官方：tool_calls 指南 / thinking 模式 / 定价与限流 / 模型更新记录（api-docs.deepseek.com）
- OWASP GenAI：LLM Top 10 2026（2026-08-03）、Top 10 for Agentic Applications（2025-12）、LLM01:2025 缓解清单、AISVS C02
- 防御模式：微软 Spotlighting 与 MSRC 间接注入防御；Google DeepMind CaMeL；14 人 Design Patterns for Securing LLM Agents；Willison「致命三角」；OpenAI 指令层级与 2026 安全指南；MCP 安全最佳实践
- 事故复盘：Bing Sydney、Chevrolet、Air Canada（Moffatt 案）、DPD、Slack AI、EchoLeak (CVE-2025-32711)、GitHub MCP、Gemini 记忆投毒、Amazon Q 隐形字符、Immersive Labs 挑战
- 业界案例：Mintlify AI Assistant、Kapa@Netlify、Inkeep@Descope MCP
- Vercel AI SDK v7（备选路线 B 参考）
