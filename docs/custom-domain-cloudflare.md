# 自有域名 + Cloudflare（后续接入指南）

本站正式域名为 **`https://tengjun.org`**。若仍保留 Vercel 子域（例如 `*.vercel.app`）作为备用，**`*.vercel.app` 的 DNS 由 Vercel 管理**，无法单独把它加进 Cloudflare 做自定义 WAF；自有域名接入 Cloudflare 后，边缘防护可与应用层（限流、`dr_gate`、同源写保护等）互补。

绑定**你自己购买的域名**后，可以把 DNS 放在 Cloudflare，并在边缘做机器人 / 威胁清洗，与源码里的防护互补。

---

## 一、在 Vercel 绑定域名

1. 打开 Vercel 项目 → **Settings** → **Domains**。
2. 输入你的域名（本站为 `tengjun.org`，若使用 `www` 子域则一并添加），按提示完成验证。
3. 记下 Vercel 要求配置的 DNS 记录类型（通常是 **CNAME** 指向 `cname.vercel-dns.com`，或根域用 **A** 记录指向 Vercel 提供的 IP）。以控制台显示为准。

---

## 二、在 Cloudflare 接入该域名

1. 在 Cloudflare 注册 / 登录 → **Add a Site**，输入同一域名并完成向导。
2. 若域名注册商处 nameserver 已指向 Cloudflare，之后在 Cloudflare **DNS** 里添加 Vercel 要求的记录即可。

### DNS 与代理（橙云）的两种常见做法

| 模式 | 说明 |
|------|------|
| **仅 DNS（灰云）** | DNS 由 Cloudflare 解析，访客直连 Vercel。简单，但**不用** Cloudflare 的 WAF / 质询。 |
| **已代理（橙云）** | 流量经 Cloudflare 边缘，可使用 WAF、质询、部分限速能力。个人博客常用此方式做「前面挡一层」。 |

若使用橙云：在 **SSL/TLS** 中建议使用 **Full (strict)**，并确保证书正常（避免无限重定向时可先试 **Full** 再改为 **Full (strict)**）。

---

## 三、主机名白名单（可选，防泛解析 / 陌生 Host）

在 **Security → WAF → Custom rules** 新增规则（将下面列表改成你实际使用的全部主机名，例如根域、`www`、以及是否还有其它别名）：

- **名称**：`仅允许正式主机名`
- **表达式**：

```txt
(not http.host in {"tengjun.org" "www.tengjun.org"})
```

- **操作**：Block

若还有 Vercel 给的验证子域或其它别名，必须一并写进 `in { ... }`，否则会误拦。

---

## 四、WAF 自定义规则草稿（已按 `tengjun.org` 示例；若主机名不同请替换）

以下均在 **Security → WAF → Custom rules** 中配置。免费套餐有规则条数上限，可按需删减。

### 规则 1：API 路径 + 高威胁分数 → 托管质询

- **名称**：`API 高威胁分 - 质询`
- **表达式**：

```txt
(http.request.uri.path starts with "/api/") and (cf.threat_score gt 14)
```

- **操作**：Managed Challenge（托管质询）

阈值可在约 `10`～`25` 之间按误拦情况微调。

### 规则 2：空 User-Agent 访问 API → 拦截

- **名称**：`API 空 UA - 拦截`
- **表达式**：

```txt
(http.request.uri.path starts with "/api/") and (http.user_agent eq "")
```

- **操作**：Block

### 规则 3（有套餐时）：登录接口限速

在 **Security → WAF → Rate limiting rules**（或当前套餐下的速率限制产品）中，对例如：

- **路径**：匹配 `/api/auth/login`
- **方法**：`POST`
- **阈值**：例如每 IP **10 次 / 10 分钟**，超限 **Block** 或 **Managed Challenge**

具体界面与是否收费以 [Cloudflare 文档](https://developers.cloudflare.com/waf/) 为准。免费层可更多依赖 **Bot Fight Mode** 与本项目自带的登录限流。

---

## 五、建议同时开启的 Cloudflare 能力

1. **Security → Bots**：打开 **Bot Fight Mode**（免费层可用），减轻脚本扫站。
2. **SSL/TLS**：优先 **Full (strict)**；根域建议打开 **Always Use HTTPS**。

---

## 六、与本项目代码里的防护的关系

| 层级 | 作用 |
|------|------|
| 应用内（本仓库） | Cookie 门闸、IP / Upstash 限流、可疑 UA、同源写保护、安全响应头、登录失败延迟等。 |
| Cloudflare（自有域名 + 橙云） | 大规模垃圾流量、部分自动化请求、高危 IP / 威胁分等在边缘先被清洗或质询。 |

两者叠加，**不能**阻止真人用浏览器逐篇复制正文；目的是降低「批量、自动化、低成本」扒库与滥用接口的概率。

---

## 七、检查清单（绑域上线后）

- [ ] Vercel 域名状态为 **Valid**
- [ ] 浏览器访问 `https://你的域名` 与 `https://你的域名/blog` 正常
- [ ] 后台登录、发布、评论流程走通（若 API 被质询过于频繁，适当放宽威胁分规则）
- [ ] Cloudflare 橙云 + SSL 无重定向循环

若实际使用的主机名与 **`tengjun.org` / `www.tengjun.org`** 不一致（或还有其它合法别名），请在 WAF 表达式中一并列入 `http.host in { ... }`，避免误拦。
