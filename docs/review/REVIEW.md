# ShortLink 全仓代码审查报告

> 审查日期：2026-10-17 · 范围：`apps/worker`（Cloudflare Worker 后端）、`apps/web`（React 前端）、CI/部署与工程配置
> 目的：找出薄弱点并按严重级别分级，供后续分轮开修复任务使用。本报告不修改任何业务代码。

## 严重级别说明

| 级别 | 含义 |
|---|---|
| **Critical** | 可直接导致账户接管、数据泄露或全站沦陷，需立即修复 |
| **High** | 现实条件下可被利用造成明显危害（凭证泄露、越权、会话劫持、带病上线） |
| **Medium** | 需要一定条件或纵深防御缺失，可被组合利用或造成可用性/一致性问题 |
| **Low** | 加固项、边界与体验问题，风险有限 |

---

## 一、后端 `apps/worker`

### 安全

#### BE-S1 · High — audit_log 将 SMTP 密码 / Resend API Key 明文落库
- **位置**：`apps/worker/src/routes/admin.ts:445-447`
- **问题**：`PUT /api/admin/settings` 的审计日志 `details: Object.fromEntries(updates)` 会把本次提交的全部键值写入 `audit_logs`，其中包括 `smtp_pass`、`resend_api_key` 明文。同时 `GET /api/admin/settings`（admin.ts:324-335）把所有密钥明文回传给前端。
- **场景**：审计表本应是低敏数据，却成为密钥副本；任何能读 D1 / 审计日志的人（备份、分析导出、未来的只读角色）即获得发信凭据。密钥明文回传也使管理页 XSS 或浏览器恶意扩展可直接读走凭据。
- **建议**：审计 details 中对 `smtp_pass`/`resend_api_key` 做掩码（如 `"***"`）；`GET /settings` 对密钥类字段只回传掩码或 `is_set` 布尔；前端只在用户显式输入时提交密钥字段。

#### BE-S2 · High — SMTP 支持 STARTTLS 静默降级为明文连接
- **位置**：`apps/worker/src/lib/smtp.ts:75-93`（`tryStartTls` 注释明确 "server declined STARTTLS — continue plain"）
- **问题**：非 465 端口时若服务器拒绝 STARTTLS，会话继续走明文，随后 `AUTH LOGIN` 把 base64 用户名/密码在明文信道上传输。
- **场景**：管理员配置的 SMTP 服务器被中间人（或配置错误指向明文端口）时，SMTP 凭据和邮件内容（含 OTP/重置码）被窃听——OTP 本身即可用于账户接管。
- **建议**：STARTTLS 失败直接抛错中断；如确需内网明文中继，做成显式开关（如 `smtp_allow_plaintext = 'true'`）并在管理界面警示。同时给 socket 读写加超时（见 BE-R1）。

#### BE-S3 · Medium — 密码重置/修改后未吊销其他会话
- **位置**：`apps/worker/src/routes/auth.ts:1606-1666`（reset-password）、`575-628`（change-password）
- **问题**：`change-password` 只吊销当前 access/refresh token 的 jti；`reset-password` 完全不吊销任何 token。用户的其他已登录会话（包括攻击者已窃取的 refresh cookie，7 天有效）在密码变更后依然可用。
- **场景**：用户发现账号被盗后改密码，攻击者手中的 refresh token 仍可换发新 access token，重置密码没有实际效果。
- **建议**：引入 per-user `token_version`（或 `password_changed_at`）字段，签发/校验 token 时对比；密码变更时自增，使所有旧 token 失效。

#### BE-S4 · Medium — 用户被停用/降权后，既有 access token 最长仍可用 15 分钟
- **位置**：`apps/worker/src/middleware/auth.ts:11-34`、`apps/worker/src/routes/admin.ts:182-232`
- **问题**：`requireAuth`/`requireAdmin` 只验 JWT 签名 + jti 黑名单，不查库确认 `is_active`/`role`；role 以 token claim 为准。admin 停用或降权用户后，其 access token 在剩余有效期（≤15 min）内仍可调全部 API（admin 甚至可调 `/api/admin/*`）。
- **场景**：被停用的恶意用户在窗口期内批量导出/删除数据；被降权的前管理员在窗口期内仍有全权。
- **建议**：admin 的 PATCH/DELETE 用户操作时，把该用户已知的活跃 jti 记入黑名单（需记录签发侧 jti，配合 BE-S3 的 token_version 更简单：requireAdmin 校验时比对版本）。退一步可把 access token TTL 缩短并在 admin 路由做 `is_active` 实时校验。

#### BE-S5 · Medium — `/setup/:secret` 通过 GET 传密钥且明文比较、无限流
- **位置**：`apps/worker/src/routes/setup.ts:147-151`
- **问题**：(a) 密钥在 URL path 中，会进入访问日志、浏览器历史、CDN 日志；(b) `secret !== c.env.SETUP_SECRET` 为非常量时间比较；(c) 端点无任何限流，可在线爆破；(d) GET 语义下执行建表写操作。
- **场景**：日志泄漏 SETUP_SECRET → 任何人触发迁移；弱密钥可被爆破。当前迁移是幂等的，直接危害有限，但属于初始化接口暴露面。
- **建议**：改为 POST + Header（`X-Setup-Secret`）传密钥；常量时间比较；加 KV 限流；部署完成后文档建议立即 `wrangler secret delete SETUP_SECRET`（未设置时端点已自动 404，这点做得好）。

#### BE-S6 · Medium — 登录限流按 email 维度，可被用作账户锁定 DoS；注册/忘记密码缺少 IP 维度限流
- **位置**：`apps/worker/src/lib/kv.ts:151-184`、`apps/worker/src/routes/auth.ts:413-432,1552-1603`
- **问题**：(a) `checkLoginRateLimit` 只按 email 计数——攻击者对受害邮箱故意输错 10 次即可让受害者 15 分钟无法登录；(b) `/register` 完全没有限流；(c) `/forgot-password` 按目标 email 限流（3 次/小时），攻击者可对任意受害者邮箱每天发 72 封重置邮件（邮件轰炸），且不校验发起 IP。
- **场景**：批量骚扰/锁定用户；注册接口被脚本批量建号（注册开放时）。
- **建议**：登录限流改为 email+IP 双维度（IP 维度用 `cf-connecting-ip`）；`/register`、`/forgot-password` 增加 IP 维度限流；在 Cloudflare 层配置 WAF Rate Limiting 作为主防线（kv.ts:147-149 注释已承认 KV 计数非原子，仅为纵深防御）。

#### BE-S7 · Medium — WebAuthn challenge、refresh 轮换均存在 KV TOCTOU 竞态
- **位置**：`apps/worker/src/lib/kv.ts:75-82`（getAndDeletePasskeyChallenge）、`apps/worker/src/routes/auth.ts:510-543`（refresh）
- **问题**：KV get→delete 非原子且最终一致。(a) 同一 passkey challenge 在并发下可被使用两次；(b) refresh 流程中"查黑名单→写黑名单→签发新 token"非原子，同一 refresh token 并发两次请求可各换出一套新 token（refresh token 重放窗口）。
- **场景**：(b) 被盗 refresh token 与合法用户并发使用时双方都能持续续期，削弱了轮换检测的意义。
- **建议**：refresh 轮换检测引入"重用即全家吊销"策略（检测旧 jti 二次使用时吊销该用户全部会话，配合 BE-S3 的 token_version）；challenge 竞态接受现状但应在文档中记录（代码注释已部分说明）。

#### BE-S8 · Low — 注册接口可通过 409 响应枚举已注册邮箱/用户名
- **位置**：`apps/worker/src/routes/auth.ts:203-210`
- **问题**：`Email or username already taken` 明确暴露占用情况（登录侧已用 dummy PBKDF2 做了防枚举，注册侧没有）。
- **建议**：开放注册场景属常见取舍，可接受；若在意，可在要求邮箱验证的模式下统一返回"验证邮件已发送"。

#### BE-S9 · Low — 忘记密码存在时间侧信道枚举
- **位置**：`apps/worker/src/routes/auth.ts:1552-1603`
- **问题**：用户存在时走 sendEmail（数百毫秒），不存在时立即返回；响应时间差可枚举注册邮箱。
- **建议**：不存在时也走一次等时假的延时（或统一 `executionCtx.waitUntil` 异步发信并立即返回）。

#### BE-S10 · Low — CORS 白名单在生产环境仍放行 localhost
- **位置**：`apps/worker/src/index.ts:36-44`
- **问题**：`http://localhost:5173/4173` 始终被允许且 `credentials: true`。本机恶意网页若监听这两个端口可携带用户 cookie 调 API（需诱导访问，门槛较高）。
- **建议**：按 `ENVIRONMENT` 变量仅在 dev 时放行 localhost。

#### BE-S11 · Low — 安全头只加在 `/api/*`，SPA 静态资源无 CSP
- **位置**：`apps/worker/src/index.ts:17-32, 115`
- **问题**：`app.all('*')` 透传到 Workers Assets 的响应不带 CSP/X-Frame-Options 等任何安全头。
- **建议**：通过 `_headers` 文件或在 assets 回包路径上补安全头（CSP 需兼容 Vite 产物）。

#### BE-S12 · Low — TOTP setup 用 GET 且有写副作用；重复调用会覆盖进行中的 secret
- **位置**：`apps/worker/src/routes/auth.ts:635-661`
- **问题**：`GET /2fa/totp/setup` 每次调用都重新生成并覆盖 `totp_secret`。无实际越权，但语义不佳，且日志可能记录含语义的端点调用。
- **建议**：改 POST；确认页过期重试逻辑不受影响。

### 正确性

#### BE-C1 · Medium — `page`/`limit` 解析无 NaN 防护
- **位置**：`apps/worker/src/routes/links.ts:38-44`、`apps/worker/src/routes/admin.ts:55-61, 271-278`、`apps/worker/src/routes/analytics.ts:36-39`
- **问题**：`Math.max(1, parseInt('abc', 10))` = `NaN`，传入 LIMIT/OFFSET 导致 D1 抛错 → 500。
- **建议**：`const n = parseInt(...); if (!Number.isFinite(n)) n = 1` 类的统一 helper。

#### BE-C2 · Medium — `links.user_seq` 用 `MAX(user_seq)+1` 子查询，并发创建会撞号
- **位置**：`apps/worker/src/routes/links.ts:169-175`
- **问题**：两个并发 INSERT 读到同一 MAX，产生相同 user_seq（无唯一约束兜底时重复；有约束则一个失败返回 500）。user_seq 仅用于展示排序，危害低。
- **建议**：接受无序或用 `(user_id, user_seq)` 唯一索引 + 冲突重试。

#### BE-C3 · Low — register 邮箱验证分支与唯一性约束存在并发窗口
- **位置**：`apps/worker/src/routes/auth.ts:203-266`
- **问题**：先 SELECT 查重再 INSERT，并发同邮箱注册时后者依赖 DB UNIQUE 约束抛错，但代码没有 catch → 500 而非 409。
- **建议**：捕获 D1 唯一约束错误映射为 409。

#### BE-C4 · Low — `verifications` 查询 `ORDER BY created_at DESC LIMIT 1` 与"删旧插新"模式冗余
- **位置**：`apps/worker/src/routes/auth.ts` 多处（306-310、879-883、1104-1109、1522-1527、1630-1634）
- **问题**：大部分发送路径已先 DELETE 旧码再 INSERT，但 verify-email 的注册分支（250-254）没有先删旧码，重复注册未激活账户时会积累多条，取最新一条语义正确但依赖 created_at 精度（秒级），同秒插入顺序未定。
- **建议**：统一发送前删除旧码；或给查询加二级排序键（rowid）。

### 可靠性

#### BE-R1 · Medium — SMTP 无超时；Resend fetch 无超时
- **位置**：`apps/worker/src/lib/smtp.ts`（全文件无超时）、`apps/worker/src/lib/email.ts:72-89`
- **问题**：SMTP 服务器无响应时 `reader.read()` 永久挂起直到 Worker CPU/wall 限制；Resend fetch 同理。注册/重置流程会一直转圈直到平台杀请求。
- **建议**：SMTP 每步读写包一层超时（如 10s，超即 throw）；fetch 用 `AbortSignal.timeout(10_000)`。

#### BE-R2 · Low — 发信失败处理不一致：注册会回滚用户，重发/OTP 仅 500
- **位置**：`apps/worker/src/routes/auth.ts:232-248, 382-393, 1579-1587`
- **问题**：行为本身合理，但 `sendEmail` 的错误信息（含 Resend 响应正文，email.ts:86-89）可能经日志泄漏 SMTP 配置细节；当前仅抛给上层返回通用 500，可接受。
- **建议**：记录错误时脱敏；统一失败文案（现状已基本统一）。

#### BE-R3 · Low — KV 写入失败会使登录/登出整体失败
- **位置**：`apps/worker/src/routes/auth.ts`（resetLoginAttempts、denylistJti 等均直接 await）
- **问题**：KV 故障时 logout、refresh、登录全链路 500。属平台级故障，可接受，但建议在 KV 不可用时降级（如黑名单读失败放行+告警 vs 拒绝——需权衡）。
- **建议**：至少在全站错误处理中把 KV 错误与业务错误区分记录，便于排障。

### 工程质量

#### BE-Q1 · Medium — schema 双份事实来源：`migrations/0001_init.sql` 与 `routes/setup.ts` 内联 SQL
- **位置**：`apps/worker/migrations/0001_init.sql`、`apps/worker/src/routes/setup.ts:17-131`
- **问题**：两处 DDL 各自维护，必然漂移（例如将来加字段只改一处）。
- **建议**：只保留 wrangler migrations 一条路径，删除 setup 内联 SQL 或让它读 migrations 文件（构建时注入）。

#### BE-Q2 · Medium — 全仓无任何自动化测试
- **位置**：`apps/worker/package.json`、`apps/web/package.json`（均无 test 脚本）
- **问题**：认证、2FA、限流、redirect 等关键逻辑零测试覆盖，而 CI 通过后即自动部署（见 CI-C1）。
- **建议**：worker 用 `@cloudflare/vitest-pool-workers` 覆盖 auth/links/redirect 关键路径；前端至少给 client.ts 的 refresh 逻辑配单测。

#### BE-Q3 · Low — 错误响应不区分日志级别、无统一 onError
- **位置**：`apps/worker/src/index.ts`
- **问题**：Hono 默认 onError 返回 500 文本，无结构化日志、无 requestId。
- **建议**：注册 `app.onError`，输出结构化日志（含路径与错误名），开启 wrangler observability。

---

## 二、前端 `apps/web`

### 安全

#### FE-S1 · High — access token 经 BroadcastChannel 在同源标签页间明文广播
- **位置**：`apps/web/src/contexts/AuthContext.tsx:60-83, 106-133`
- **问题**：登录/刷新后向 `BroadcastChannel('auth')` `postMessage` 明文 access token。同源任何脚本（一处 XSS、恶意浏览器扩展注入的 content script 之外的所有页面脚本）可监听频道直接取走 token；也可反向注入伪造 token 强制其他标签页切换会话。`logout` 消息同样可伪造（强制登出）。
- **场景**：任一处 XSS（如 FE-S2 的管理员链接 XSS）从"单页脚本执行"升级为"持久窃取实时 token"。
- **建议**：频道只广播"已刷新/已登出"信号，各标签页凭 HttpOnly refresh cookie 自行调 `/auth/refresh` 取 token，token 永不跨上下文传递。

#### FE-S2 · High — 管理端/用户端链接列表直接渲染用户可控 URL 为 `<a href>`
- **位置**：`apps/web/src/components/link-table-cells.tsx:41-48`、`apps/web/src/pages/dashboard/AnalyticsPage.tsx`（destination 展示处）
- **问题**：后端创建/更新时已校验仅允许 http/https（links.ts:111-118, 259-267），纵深是完整的；但前端把 `destination_url` 直接绑进 `href`，一旦后端校验被绕过（未来新入口、直接写库、API 客户端构造），`javascript:` 链接在管理员点击时即管理员会话 XSS。React 18 对 `javascript:` URL 不再警告。
- **建议**：前端渲染前 `new URL()` 校验协议白名单（`lib/utils.ts` 加 `isSafeUrl()`），不安全则纯文本展示。

#### FE-S3 · Medium — 管理设置页把 SMTP 密码/API Key 明文回填表单
- **位置**：`apps/web/src/pages/admin/AdminSettingsPage.tsx:56-62`（依赖后端 BE-S1 的回传）
- **建议**：后端改掩码后，前端相应改为"留空表示不修改"。

### 正确性

#### FE-C1 · Medium — CreateLinkDialog 切换过期选项后旧值残留进 payload
- **位置**：`apps/web/src/pages/dashboard/LinksPage.tsx:240-243`
- **问题**：先选 custom 写入 `expiresAt`，再切回 "7 天" 或 "never" 时 `form.expiresAt` 仍在 payload 中；后端 `expiresAt` 优先于 `expiryDays`（links.ts:151-167），用户的选择被静默忽略。
- **建议**：提交前按 `expiryOption` 显式清空另一字段。

#### FE-C2 · Medium — 编辑链接的 `datetime-local` 用 UTC 填充、按本地时区解析
- **位置**：`apps/web/src/pages/dashboard/LinksPage.tsx:400-402, 446-452`
- **问题**：`toISOString().slice(0,16)` 是 UTC，而 `datetime-local` 按本地时区显示/解析，双向各偏移一次，过期时间与用户预期差若干小时。
- **建议**：用本地时区格式化（`padStart` 拼本地年月日时分）。

#### FE-C3 · Medium — TwoFactorPage 在渲染期调用 `navigate`
- **位置**：`apps/web/src/pages/auth/TwoFactorPage.tsx:39-42`
- **问题**：渲染期副作用违反 React 规则，StrictMode 下警告/双执行。
- **建议**：改 `<Navigate to="/login" replace />` 或 `useEffect`。

#### FE-C4 · Medium — RegisterPage 未处理 verify-email 返回缺 token 的分支
- **位置**：`apps/web/src/pages/auth/RegisterPage.tsx:66-72`
- **问题**：若响应无 `accessToken`（如后端策略变化返回 requiresTwoFactor），仍 `refreshUser(); navigate('/dashboard')`，随后被路由守卫弹回登录页，用户困惑。
- **建议**：显式校验 `result.accessToken` 存在再走成功路径。

#### FE-C5 · Low — 多处小正确性问题
- `apps/web/src/lib/utils.ts:31-37`：剩余 <1h 显示 "0h remaining"；未校验 `expires_at` 单位（秒/毫秒混用即全错）。
- `apps/web/src/pages/admin/AdminUsersPage.tsx:127-170`：mutation pending 期间控件未禁用，连点产生竞态请求。
- `apps/web/src/pages/dashboard/AnalyticsPage.tsx:37-38`：`useSearchParams` 只读初始值，浏览器前进/后退不同步。
- `apps/web/src/hooks/use-countdown.ts`：后台标签页 setTimeout 节流导致倒计时与服务端过期漂移。

### 可靠性

#### FE-R1 · Medium — refresh 遇网络异常等同 401：断网即被登出
- **位置**：`apps/web/src/api/client.ts:88-101, 57-60`
- **问题**：`_doRefresh` 捕获一切异常（含网络抖动）返回 false → 清 token + 跳 `/login`。用户断网 2 秒即丢失内存会话（refresh cookie 仍有效）。
- **建议**：区分网络错误（保留会话、交给 react-query 重试）与 401/403（真过期才登出）。

#### FE-R2 · Medium — refresh 失败时并发请求各自硬跳 `/login`
- **位置**：`apps/web/src/api/client.ts:39-61`
- **问题**：多个并发 401 → 一次 refresh 失败 → 每个请求都执行 `window.location.href='/login'` 并各自 toast "Session expired"。
- **建议**：跳转去重（模块级标志位），并改用 router navigate 保持 SPA 语义。

#### FE-R3 · Medium — AppConfig 初始 `registrationEnabled=false` 导致注册页误跳转/闪烁
- **位置**：`apps/web/src/contexts/AppConfigContext.tsx:25`、`apps/web/src/pages/auth/RegisterPage.tsx:38-40`
- **问题**：直接打开 `/register` 时 config 未加载完成即按默认值 false 重定向到 `/login`；`/api/config` 失败时静默隐藏注册入口且无任何提示。
- **建议**：AppConfig 增加 `isLoading`，RegisterPage 等加载完成再决策；加载失败显示错误。

#### FE-R4 · Low — react-query 对 4xx 也重试一次；搜索输入无防抖
- **位置**：`apps/web/src/main.tsx:13-20`、各列表页搜索框
- **建议**：`retry` 只对网络错误/5xx 重试；搜索加 300ms debounce。

#### FE-R5 · Low — 401 硬跳转丢失路由状态；剪贴板无失败处理
- **位置**：`apps/web/src/api/client.ts:59`、`apps/web/src/lib/utils.ts:39-41`
- **建议**：用 navigate 并带 `?next=`；`copyToClipboard` 调用处 `.catch` + toast。

### 工程质量

- **FE-Q1 · Low**：toast 文案大量硬编码英文（`'Link deleted'`、`'Session expired'` 等），绕过 i18n。
- **FE-Q2 · Low**：删除确认 Dialog 在三个页面近乎复制粘贴，可抽 `<ConfirmDialog>`；`startCountdown(600)` 魔数散落 4 处。
- **FE-Q3 · Low**：API 类型暴露 SQLite 的 `0/1` 数字布尔（`is_active` 等），前端到处 `!!x`，一处遗漏即 truthy 误判；建议 client 层归一化为 boolean。

---

## 三、CI / 部署 / 工程配置

#### CI-C1 · High — 无任何测试步骤，CI 通过即自动部署生产
- **位置**：`.github/workflows/ci.yml:10-36`、`.github/workflows/deploy.yml:4-13`、根 `package.json`（无 test 脚本）
- **问题**：CI 只有 check/typecheck/build；`workflow_run` 成功后自动 deploy。逻辑回归（认证、2FA、跳转）可零阻碍上线。
- **建议**：引入 vitest + `@cloudflare/vitest-pool-workers`，`pnpm test` 作为 deploy 门禁。

#### CI-C2 · High — deploy 未锁定触发 CI 的 commit
- **位置**：`.github/workflows/deploy.yml:10-13`（checkout 默认分支 HEAD）
- **问题**：CI 对 commit A 成功，到 deploy 执行时 main 已到未验证的 commit B，B 被直接部署。
- **建议**：`actions/checkout` 加 `ref: ${{ github.event.workflow_run.head_sha }}`。

#### CI-C3 · High — CI job 未声明 `permissions`
- **位置**：`.github/workflows/ci.yml`（全文件）
- **问题**：默认 GITHUB_TOKEN 权限过大，第三方 action 供应链投毒时可写仓库。
- **建议**：顶层 `permissions: { contents: read }`。

#### CI-C4 · High — `tag.yml` 使用长期 PAT_TOKEN 推 tag
- **位置**：`.github/workflows/tag.yml:31`
- **问题**：PAT 权限大、不过期；推 tag 用默认 GITHUB_TOKEN + `contents: write` 即可。
- **建议**：删除 PAT，改用 GITHUB_TOKEN 并声明最小 permissions。

#### CI-C5 · High — 代码部署与 D1 迁移脱钩
- **位置**：`apps/worker/package.json:9`（deploy 仅 `wrangler deploy`）、`deploy.yml`（无迁移步骤）
- **问题**：新代码依赖新 schema 而迁移未跑（或反之）→ 生产 500。发布顺序无约定。
- **建议**：deploy workflow 增加 `wrangler d1 migrations apply --remote` 步骤并定义 expand-migrate-contract 顺序。

#### CI-C6 · Medium — `pnpm install` 未加 `--frozen-lockfile`；无依赖安全扫描
- **位置**：`.github/workflows/ci.yml:27`
- **建议**：加 `--frozen-lockfile`；增加 `pnpm audit --prod --audit-level=high` / CodeQL / Dependabot。安全敏感依赖（`jose`、`@simplewebauthn/server`）建议 pin 精确版本。

#### CI-C7 · Medium — deploy 用 sed 注入资源 ID，无环境分层
- **位置**：`.github/workflows/deploy.yml:32-36`、`apps/worker/wrangler.toml`
- **问题**：sed 不校验变量为空、特殊字符可破坏文件；`vars.*` 明文入日志；wrangler.toml 无 `[env.*]` 分层、占位符入库。
- **建议**：改用 `wrangler.toml` 原生 `[env.production]` + `wrangler deploy --env`；敏感值一律 secrets。

#### CI-C8 · Medium — deploy 无 environment 保护、无并发控制、无部署后验证
- **位置**：`.github/workflows/deploy.yml:12-13, 39`
- **建议**：加 `environment: production`（人工审批）、`concurrency: deploy-production`；deploy 后 `curl -f /api/health` 冒烟；文档化 `wrangler rollback`。

#### CI-C9 · Low — 其他加固项
- actions 未 pin 到 commit SHA（ci.yml:17-21 等）；`turbo.json:15-18` 的 `deploy` task 建议显式 `"cache": false`；`tag.yml` 打 tag 前不校验 CI 状态；`release.yml` 任何 `v*` tag 即发版无来源校验。
- `wrangler.toml:3` `compatibility_date` 偏旧；`nodejs_compat` 全局开启可评估必要性；无 observability/routes 声明；`keep_vars = true` 允许控制台配置漂移。
- `apps/web/vite.config.ts:13-20` dev proxy 硬编码 localhost，无 sourcemap 策略。

---

## 四、汇总统计

| 级别 | 数量 | 条目 |
|---|---|---|
| Critical | 0 | — |
| High | 9 | BE-S1、BE-S2、FE-S1、FE-S2、CI-C1、CI-C2、CI-C3、CI-C4、CI-C5 |
| Medium | 20 | BE-S3~S7、BE-C1、BE-C2、BE-Q1、BE-Q2、BE-R1、FE-S3、FE-C1~C4、FE-R1~R3、CI-C6~C8 |
| Low | 25+ | BE-S8~S12、BE-C3~C4、BE-R2~R3、BE-Q3、FE-C5、FE-R4~R5、FE-Q1~Q3、CI-C9 等 |

## 五、建议的修复分轮

**第 1 轮 — 安全（High 优先）**
1. BE-S1：审计日志与 settings API 脱敏（含 FE-S3 前端配合）。
2. BE-S2：SMTP STARTTLS 失败即中断 + 读写超时（连同 BE-R1）。
3. FE-S2 + FE-S1：前端 URL 协议白名单；BroadcastChannel 改为只传信号不传 token。
4. BE-S3：token_version 机制，密码变更/重置全端吊销（顺带解决 BE-S4、BE-S7 的吊销面）。
5. BE-S5：setup 端点改 POST + Header + 常量时间比较 + 限流。
6. BE-S6：登录/注册/忘记密码增加 IP 维度限流。

**第 2 轮 — CI/部署安全（可与第 1 轮并行）**
1. CI-C3/C4：permissions 最小化、移除 PAT_TOKEN。
2. CI-C2 + CI-C8：deploy 锁 head_sha、environment 保护、并发控制、部署后冒烟。
3. CI-C5：部署流程纳入 D1 迁移。
4. CI-C6：frozen-lockfile + 依赖审计。

**第 3 轮 — 正确性**
1. FE-C1/C2（链接表单过期时间两处）、FE-C3/C4（认证流程页面）。
2. BE-C1（分页 NaN）、BE-C3（注册并发 409）、FE-R1~R3（refresh 与 AppConfig 可靠性）。
3. BE-R1 若第 1 轮未做则补上。

**第 4 轮 — 工程质量与加固**
1. BE-Q2 + CI-C1：建立测试基线（auth/redirect/links 关键路径），接入 CI 门禁。
2. BE-Q1：schema 单一事实来源。
3. 前端 ConfirmDialog 抽取、i18n 补齐、类型归一化、搜索防抖。
4. Low 级安全加固批量处理（BE-S8~S12、CI-C9）。
