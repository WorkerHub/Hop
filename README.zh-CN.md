# Hop

[English](./README.md)

一个完全基于 Cloudflare 平台的自托管短链接服务。无需管理服务器 — 运行于 Workers、D1（SQLite）和 KV 之上。

## 功能特性

- **短链接** — 随机 4 字符 slug 或自定义别名
- **点击分析** — 通过 Cloudflare 地理位置头信息追踪国家、设备、浏览器、操作系统和来源
- **多用户** — 注册可开放或仅限邀请；第一个注册用户自动成为管理员
- **三种双因素认证** — TOTP（认证器应用）、Passkey（WebAuthn）、邮件 OTP
- **管理面板** — 管理用户、查看所有链接、配置全局设置
- **链接有效期** — 按日期或天数设置过期时间
- **零出口费用** — KV 缓存重定向查询；点击日志记录为非阻塞操作

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | TypeScript + Hono.js on Cloudflare Workers |
| 前端 | React 18 + Vite + shadcn/ui + Tailwind CSS |
| 数据库 | Cloudflare D1（SQLite） |
| 缓存 | Cloudflare KV |
| 邮件 | Resend API **或** 自定义 SMTP 服务器（可在管理界面切换） |
| 图表 | Recharts + react-simple-maps |
| 双因素认证 | otpauth（TOTP）+ @simplewebauthn/server（Passkey）+ 邮件 OTP |

## 部署

### 前置条件

- [Cloudflare 账户](https://dash.cloudflare.com)

### 1. Fork 本仓库

把本仓库fork到自己账户/组织内。

### 2. 创建 Cloudflare 资源

在Cloudflare中创建如下资源，名称均可自定义，请记录id备用。

|资源|名称|
|---|---|
| WORKERS KV | `LINKS_KV`（可自定义） |
| D1 SQL databases | `Hop`（可自定义） |


### 3. 添加 GitHub Actions 密钥与变量

在你的 GitHub 仓库中前往 **Settings → Secrets and variables → Actions** 

添加 Repository secrets（deploy 工作流读取；`JWT_SECRET`、`SETUP_SECRET`、`TOTP_ENCRYPTION_KEY` 三项均经 CI 以 `--secrets-file` 上传为 Cloudflare Secret，因此一律不在 Cloudflare 控制台配置）：

| 密钥 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 进入[User API Tokens](https://dash.cloudflare.com/profile/api-tokens)页面，使用 **Edit Cloudflare Workers** 模板创建的 API 令牌。需具备目标 D1 的编辑权限、Worker 的编辑/版本读取权限，以及 Workers Scripts:Read（未配 `APP_URL` 时 smoke test 要读 workers.dev 子域名）。 |
| `JWT_SECRET` | 任意长度 ≥ 32 字符的随机字符串。CI 经 `--secrets-file` 上传为 Cloudflare Secret。 |
| `SETUP_SECRET` | `openssl rand -hex 24`。CI 经 `--secrets-file` 上传为 Cloudflare Secret，用于 setup/迁移。 |
| `TOTP_ENCRYPTION_KEY` | `openssl rand -hex 32`。CI 经 `--secrets-file` 上传为 Cloudflare Secret；加密 TOTP 凭据，轮换会使已绑定的 TOTP 全部失效。该值缺失或为空时部署直接失败关闭。 |

> **存量部署迁移到 CI** — GitHub 中的 `JWT_SECRET`、`SETUP_SECRET`、`TOTP_ENCRYPTION_KEY` 值必须与 Worker 上**已有的** Cloudflare Secret **同值**：请填入现有值，切勿生成新值替代，否则 CI 会用不同值覆盖线上 Secret（对 `TOTP_ENCRYPTION_KEY` 而言，换值会让所有已绑定的 TOTP 无法解密）。值搬进 GitHub 后即由 CI 接管：请删掉控制台那份，因为控制台上的改动下次部署会被覆回。


添加 Repository variables（deploy 工作流读取）：

| 变量 | 值 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 你的账户 ID（可在 Cloudflare 控制台 URL 中找到） |
| `KV_NAMESPACE_ID`| 上一步中的 WORKERS KV ID |
| `D1_DATABASE_ID` | 上一步中的 D1 database ID |
| `D1_DATABASE_NAME` | （可选）仅当上一步自定义了 D1 数据库名称时才需配置为对应名称，否则无须配置。 |
| `TABLE_PREFIX` | （可选）三态表前缀，同时是该 Worker `TABLE_PREFIX` 绑定的**唯一真源**：未设置或为空 → 默认 `hop`；保留字 `none` → 显式无前缀；其他值 → 原值。每次部署都会把它写入 Worker 绑定——不要在 Cloudflare 控制台配置它（见第 4 步）。 |
| `APP_URL` | （可选）smoke test 探测的生产 URL（见第 6 步）。未配置时 smoke test 会自动解析并探测 Worker 的 workers.dev 地址。与第 4 步中同名的 Worker 变量无关——Worker 已不再需要它。 |

部署工作流（`.github/workflows/deploy.yml`）在部署时通过 `sed` 将这些资源 ID 与解析后的 `TABLE_PREFIX` 注入 `wrangler.toml`，因此 ID 不会提交到仓库。资源与上述值就位后，部署本身就是全新安装的全部步骤：Worker 不存在时自动创建、建表、写入 `TABLE_PREFIX` 绑定，全程无需 Cloudflare 控制台操作（见第 5 步）。

### 4. 可选的 Worker 变量

**无需任何控制台操作。** `TABLE_PREFIX` 与三把运行时密钥（`JWT_SECRET`、`SETUP_SECRET`、`TOTP_ENCRYPTION_KEY`）均来自第 3 步的 GitHub 值，由部署工作流每次运行时写入 Worker。请**不要**在 [Cloudflare 控制台](https://dash.cloudflare.com) → **Workers & Pages → Hop → Settings → Variables and Secrets** 中创建或修改它们：有前缀时，在控制台改 `TABLE_PREFIX` 会让下次部署的迁移守卫中止，直到 GitHub 与 Worker 两侧重新一致（而那次部署本来也会按 GitHub 变量把它覆回）；与控制台同名的 Secret 也会在下次部署时被 CI 覆盖。

以下变量可选地在 Worker 本体上配置——CI 不碰它们，`wrangler.toml` 中的 `keep_vars = true` 会保证跨部署保留：

| 名称 | 类型 | 必填 | 示例 / 说明 |
|---|---|---|---|
| `APP_URL` | Variable | 否 | 规范基础 URL（例如 `https://yourdomain.com`）。可选——未配置时按每个请求的 origin 推导。仅当需要固定一个与客户端实际访问地址不同的 URL 时才配置。 |
| `RP_ID` | Variable | 否 | WebAuthn 依赖方 ID（仅域名）。可选——未配置时按请求 hostname 推导。 |
| `APP_ORIGIN` | Variable | 否 | WebAuthn 来源（完整 URL）。可选——未配置时按请求 origin 推导。 |

> `TABLE_PREFIX` 故意**不列入上表**：它由部署统一托管（第 3 步）。未配置 → 默认 `hop`（`hop_users`、`hop_links` 等）；自定义值 → 该值（保留大小写，剔除 `[^a-zA-Z0-9_]`）；GitHub 中为 `none` → 显式空字符串、无前缀（部署者自担撞表风险）。请在**首次**部署前定下，一旦有数据后不得更改。
>
> `APP_URL` / `RP_ID` / `APP_ORIGIN` 均为可选：未配置时 Worker 按请求推导（见[环境变量](#环境变量)）。显式配置始终优先，因此已配置这三项的存量部署行为与改前完全一致。`APP_NAME` **不再是环境变量**——应用名称唯一来源是管理面设置 `app_name`（默认 `Hop`）。
>
> `RP_ID` / `APP_ORIGIN` 是 WebAuthn 通行密钥的依赖方标识。若配置，其值**严禁变更**——一旦变更将导致所有用户的通行密钥失效。若未配置，rpID 按用户实际访问的 hostname 推导，凭据仍按域名绑定：经正式自定义域名访问与原显式配置等价；经其他域名（例如 `*.workers.dev`）访问会得到不同的 rpID，从而形成不同的通行密钥作用域——这是多域名部署的固有行为，不是本次变更的回归。
>
> 若某个旧部署的 `TOTP_ENCRYPTION_KEY` 原本建在控制台：先把同一个值填进 GitHub Secret `TOTP_ENCRYPTION_KEY`（第 3 步）——换成别的值会让所有已绑定的 TOTP 无法解密——再删掉控制台那份。
>
> 邮件提供商设置（Resend API 密钥、SMTP 凭据等）在首次登录后通过**管理界面**配置 — 无需在 Cloudflare 控制台中配置。


### 5. 构建并部署

进入 Github Actions → Deploy → 点击右侧 Run workflow，手动触发部署（推送或合并到 `main` 后，CI 通过也会自动部署）。

全新安装点一次就够了，默认前缀与自定义前缀皆然：

- wrangler 上传代码，Worker 不存在时自动创建；
- 迁移在上传前执行，按解析出的前缀建表；
- 上传的版本带有 CI 按 GitHub 变量写入的 `TABLE_PREFIX` 绑定；
- 随后工作流通过 Cloudflare API 核对这个版本承接 100% 生产流量且前缀一致，再由 smoke test 探测部署后的 URL。

仍需人工的只有两件，且都与部署成败无关：

- **自定义域名** — 想用时何时绑都行（Workers & Pages → Hop → Settings → Domains & Routes）。在此之前部署在 workers.dev 地址上可正常访问，`APP_URL` 未配时 smoke test 自动探测该地址。
- **`APP_URL`** — 域名绑好后可选地把 GitHub 变量（第 3 步）设为生产地址，让 smoke test 探测真实生产入口。


### 6. 运行数据库迁移

GitHub Actions 会在部署代码**之前**自动执行迁移：无前缀时仍使用
`wrangler d1 migrations apply`；有前缀时使用与 setup 路由共享的
`apps/worker/src/lib/migrations.ts`，按 `_<prefix>_schema_migrations` 跳过已执行项，
并在日志中打印待执行计划。迁移必须向后兼容，只添加表、索引或列，不删除、重命名或修改现有数据。

GitHub Actions 无法区分「未设置的 `vars.TABLE_PREFIX`」与「空字符串」，因此部署脚本按三态约定解析：**未设置或为空 → 默认 `hop`**；**保留字 `none` → 显式空字符串**（无前缀）；**其他值 → 原样使用**。

> **升级警告** — 从未配置过前缀的旧部署使用无前缀表。若解析出的前缀与库中已初始化的前缀不一致，setup 与迁移会**中止报错**，而不是静默切换到另一套（通常是空的）表。升级前请先把 `TABLE_PREFIX` 配成原值（保持无前缀则配置 `TABLE_PREFIX=''`，CI 中为 `TABLE_PREFIX=none`）。在 `sl` → `hop` 默认值变更前依赖默认前缀（`sl_users` 等）的部署，需显式配置 `TABLE_PREFIX=sl`。

使用自定义前缀时，在 GitHub 的 **production environment → Variables** 中设置 `TABLE_PREFIX`
（例如 `SL`，仅字母、数字和下划线）——这是它唯一需要配置的地方。部署会把它写入 Worker 的
`TABLE_PREFIX` **明文绑定**，因此不要在 Cloudflare 控制台新增或修改该绑定，也不要把它设为 Secret
（Secret 的值读不回来，无法比对），更不要在已有数据后更换前缀。

由于该绑定由部署托管，有前缀时迁移守卫（在代码上传**之前**运行）会把现役 Worker 正在使用的前缀与
GitHub 变量比对，不一致即中止：GitHub 值写错时永远不可能迁移到别的应用的表；控制台上误改也会在
生效前被拦下（而且下次部署本来就会按 GitHub 变量把它覆回）。若 Worker 已不存在、但库里的
`<prefix>_` 表与 `_<prefix>_schema_migrations` 账本还在，账本本身就是这些表属于本应用的凭据，
守卫会放行并让本次部署重建 Worker；带前缀的表**没有**该账本时仍然中止。

`APP_URL` 为可选——配置了就探它，未配置则自动解析并探测 Worker 自己的 workers.dev 地址。
`CLOUDFLARE_API_TOKEN` 需要有目标 D1 的编辑权限、Worker 的编辑/版本读取权限，以及
Workers Scripts:Read（供上述 workers.dev 解析）。

无需在每次部署后调用 setup 接口。手动部署或应急操作仍可通过 `POST` 请求触发，
密钥放在 JSON body 中（旧的 `X-Setup-Secret` 请求头仍兼容，密钥不再通过 URL 传递）：

```
curl -X POST https://your-worker.workers.dev/api/setup \
  -H "Content-Type: application/json" \
  -d '{"secret": "<SETUP_SECRET>"}'
```

成功响应：
```json
{
  "migrations": [
    { "name": "schema_v1", "status": "applied" }
  ]
}
```

重复调用是安全的，已执行的迁移会返回 `"skipped"`。该接口按 IP 限流为每 10 分钟 3 次
（超限返回 `429` 并带 `Retry-After` 头）。`GET /api/setup/state` 返回
`{ "enabled": true | false }`，反映 `setup_page_enabled` 设置（未设置时默认启用），
它只隐藏 setup 页面、不会关闭 `POST` 迁移通道。以管理员身份登录后，也可在管理面板
通过 `POST /api/admin/setup` 触发迁移 — 无需 setup 密钥、不受 IP 限流，且每次执行都会写入审计日志。

初始化页面由 SPA 提供，路径为 `/setup`（非 API 路由）。
部署后还会通过 Cloudflare API 核对本次上传的版本承载 100% 流量，再检查公开 URL。
公开 URL 返回带 `cf-mitigated: challenge` 的 403 时仅警告（HTTP/数据库检查未能验证），
其余非 2xx 或错误的 JSON 均失败；无需关闭 Bot Fight Mode。

### 7. 首次登录

访问已部署的 URL 并注册 — 第一个账户将自动获得管理员角色，无论 `registration_enabled` 设置如何。然后前往 **Admin → Settings** 配置你的邮件提供商。

---

## 夜间清理：由 waker 独驱动

hop 的每日清理（过期 `verifications` 行 + 超过 90 秒的 `totp_used` 行）由
[waker](https://github.com/WorkerHub/waker) 投递：平台回调 `POST /_waker/execute`，执行的是与
`scheduled()` **同一个**清理函数。Worker **不再部署原生 Cron Trigger**——waker 是唯一的调度源。

没有开关要配，只认一把签名密钥：

| `WAKER_SIGNING_KEY` | `/_waker/execute` | 原生 Cron Trigger | 状态 |
|---|---|---|---|
| 未配置（或为空） | 500 `signing_key_missing`（JSON） | 无 | fail closed —— 且因为再没有别的调度源，清理根本不会跑 |
| 已配置 | 验签通过后执行清理 | 无 | 夜间清理由 waker 独驱动 |

`apps/worker/wrangler.toml` 里声明的是 `[triggers]` + `crons = []`，这个空数组才是移除动作：
Cloudflare 只在 `crons` 为空数组时删掉全部 Cron Trigger；属性为 undefined（即整段删掉）时已部署的
调度会**原样留着**，Worker 就会继续跑第二份不受管理的夜间清理。每次部署后流水线都会核对结果
（`Cron schedules: <none>`；仍读到调度则部署失败）。没有模式变量、没有平台地址、没有调度开关要配
——旧版双模式的那些部署变量已经删除，仓库里若还留着也会被代码忽略，可以一并删掉。`/_waker` 下
任何未挂载的路径都回 JSON（404 或 SDK 的稳定错误码），永远不会落到 SPA 的 200 HTML（否则平台会把
「没跑」当成「跑成功」）。

### 唯一的输入：`WAKER_SIGNING_KEY`

| 密钥 | 必填 | 来源 | 描述 |
|---|---|---|---|
| `WAKER_SIGNING_KEY` | 否 | GitHub Secret → CI | hop 项目的回调签名密钥，在 waker 管理面建项目时**一次性**展示。仓库里有这个 Secret 时，部署经 `--secrets-file` 注入，回调验签后执行清理；没有时部署照样成功，只是回调回 500 `signing_key_missing`，绝不执行未验签的任务——而原生 Cron Trigger 已经没有了，这个状态下清理不会跑。永不进日志、永不进仓库。 |

### 在 waker 管理面建任务（一次）

创建 `hop` 项目（回调地址填本 Worker 的公开地址），再建一条声明式任务——以下取值已冻结，
请逐字照抄（任务名必须与 receiver 的 key 完全一致）：

| 字段 | 值 |
|---|---|
| 任务名 | `nightly-cleanup` |
| 类型 / cron | `cron` / `0 3 * * *` |
| 时区 | `UTC` |
| `concurrency` | `forbid` |
| `misfirePolicy` | `skip` |
| `maxRetries` / `backoffSeconds` | `2` / `60` |
| `timeoutSeconds` / `jitterSeconds` | `30` / `0` |

### 接上、核对、以及回滚

1. 在 waker 建 `hop` 项目（回调地址填本 Worker 的公网根地址），把一次性展示的 signing key
   存进 GitHub Secret `WAKER_SIGNING_KEY`（与现有运行时密钥同路，绝不进仓库）后部署：receiver
   就此上线。
2. 在 waker 建并启用 `nightly-cleanup` 任务，观察一个完整日周期：waker 的执行记录有成功条目，
   Worker 日志出现 `"event":"nightly_cleanup","source":"waker"` 及删除计数与耗时。原生触发已移除，
   此后只会出现 `source: "waker"` 的记录。
3. 核对切换已生效：部署的 Verify 步输出 `Cron schedules: <none>`，
   `GET /accounts/{account_id}/workers/scripts/hop/schedules` 返回空列表，控制台该 Worker 的
   Triggers 下也没有 Cron Trigger。

回滚：把表达式写回 `apps/worker/wrangler.toml`（`[triggers] crons = ["0 3 * * *"]`）重新部署即可
——`wrangler deploy` 会用配置替换已部署的调度，原生触发恢复，waker 可以继续并行投递，也可以在
管理面停用任务。数据库无需回滚：`schema_v3` 只加法创建 `{prefix}waker_executions`，没有别的代码
读它。

若只想关掉回调：先在 waker 管理面停用或删除 `nightly-cleanup` 任务——在控制台删掉 Worker 的
`WAKER_SIGNING_KEY` 密钥后（部署只会新增密钥、从不删除），`/_waker/execute` 回 500
`signing_key_missing`；原生触发已经没有了，这个阶段清理就是完全停的。

清理结果以结构化 JSON 记录（`nightly_cleanup` 含计数、耗时与触发来源；被拒回调记
`waker_callback_rejected`，含 HTTP 状态与 SDK 错误码，如 `invalid_signature`、
`stale_timestamp`、`unknown_job`）。签名密钥永不进日志。

---

## 本地开发

```bash
# 1. 创建 apps/worker/.dev.vars
cat > apps/worker/.dev.vars << 'EOF'
# APP_URL / RP_ID / APP_ORIGIN 均可选——不配时按请求 URL 推导
# （http://localhost:8787 → rpID "localhost"）。只有测试通行密钥时才需要
# APP_ORIGIN：此时页面由 Vite dev server（:5173）提供，而 /api 代理到 Worker（:8787）。
APP_ORIGIN=http://localhost:5173
JWT_SECRET=dev-secret-at-least-32-characters-long
TOTP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
SETUP_SECRET=local-setup-secret
EOF

# 2. 将迁移应用到本地 D1
cd apps/worker && pnpm db:migrate:local && cd ../..

# 3. 启动所有服务
pnpm dev
# Worker: http://localhost:8787
# Web:    http://localhost:5173
```

Vite 开发服务器会自动将 `/api` 请求代理到 `:8787`。

---

## API 参考

### 认证

| 方法 | 路径 | 描述 |
|---|---|---|
| POST | `/api/auth/register` | 注册新账户 |
| POST | `/api/auth/login` | 登录；返回令牌或双因素认证挑战 |
| POST | `/api/auth/logout` | 吊销刷新令牌 |
| POST | `/api/auth/refresh` | 刷新访问令牌 |
| GET | `/api/auth/me` | 获取当前用户信息 |
| POST | `/api/auth/change-password` | 修改密码（需认证） |
| POST | `/api/auth/verify-email` | 使用注册时发送的验证码验证邮箱地址 |
| POST | `/api/auth/resend-verify-email` | 重新发送注册邮箱验证码 |
| POST | `/api/auth/forgot-password` | 通过邮件请求密码重置码 |
| POST | `/api/auth/verify-reset-code` | 验证密码重置码（不消耗） |
| POST | `/api/auth/reset-password` | 使用重置码和新密码完成密码重置 |

### 双因素认证 — 验证（需要登录时返回的 `pendingToken`）

| 方法 | 路径 | 描述 |
|---|---|---|
| POST | `/api/auth/2fa/totp/verify` | 使用 TOTP 码完成登录 |
| POST | `/api/auth/2fa/email-otp/send` | 发送邮件 OTP |
| POST | `/api/auth/2fa/email-otp/verify` | 使用邮件 OTP 完成登录 |
| POST | `/api/auth/2fa/passkey/verify-options` | 获取 WebAuthn 断言选项 |
| POST | `/api/auth/2fa/passkey/verify` | 使用 Passkey 完成登录 |

### 双因素认证 — 设置（需要有效会话）

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/auth/2fa/totp/setup` | 获取 TOTP 密钥 + QR URI |
| POST | `/api/auth/2fa/totp/confirm` | 确认并启用 TOTP |
| DELETE | `/api/auth/2fa/totp` | 禁用 TOTP |
| POST | `/api/auth/2fa/email-otp/send-verify` | 发送验证码以启用邮件 OTP |
| POST | `/api/auth/2fa/email-otp/enable` | 启用邮件 OTP（需要验证码） |
| DELETE | `/api/auth/2fa/email-otp` | 禁用邮件 OTP |
| GET | `/api/auth/2fa/passkey` | 列出已注册的 Passkey |
| POST | `/api/auth/2fa/passkey/register-options` | 获取 WebAuthn 注册选项 |
| POST | `/api/auth/2fa/passkey/register-verify` | 注册 Passkey |
| DELETE | `/api/auth/2fa/passkey/:id` | 删除 Passkey |

### 链接（需要认证）

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/links` | 列出你的链接（分页、可搜索） |
| POST | `/api/links` | 创建链接 |
| GET | `/api/links/:id` | 获取链接详情 |
| PUT | `/api/links/:id` | 更新链接 |
| DELETE | `/api/links/:id` | 删除链接 |

### 分析（需要认证）

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/analytics/summary` | 所有用户链接的汇总点击统计（查询参数：`days=30`） |
| GET | `/api/analytics/:linkId` | 单条链接的点击分析 |

### 管理（需要管理员角色）

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/admin/stats` | 控制台统计数据 |
| GET | `/api/admin/users` | 列出所有用户 |
| POST | `/api/admin/users` | 创建用户（管理员操作） |
| PATCH | `/api/admin/users/:id` | 更新用户角色/状态 |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| GET | `/api/admin/links` | 列出所有链接 |
| DELETE | `/api/admin/links/:id` | 删除任意链接 |
| GET | `/api/admin/settings` | 获取全局设置 |
| PUT | `/api/admin/settings` | 更新全局设置 |
| POST | `/api/admin/setup` | 以管理员身份执行数据库迁移（无需 setup 密钥；写入审计日志） |

### Setup（无需认证）

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/setup/state` | 公开接口 — 根据 `setup_page_enabled` 返回 `{ "enabled": true \| false }` |
| POST | `/api/setup` | 执行数据库迁移；JSON body `{"secret": "<SETUP_SECRET>"}`（旧的 `X-Setup-Secret` 请求头仍兼容），每 IP 每 10 分钟限 3 次 |

### 其他

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/config` | 公开应用配置（`appName`、`registrationEnabled`） |
| GET | `/api/health` | 健康检查 |

### 重定向

```
GET /:slug  →  302 跳转到目标 URL
```

---

## 环境变量

`TABLE_PREFIX` 与三把密钥均来自本仓库的 GitHub Secrets/Variables（第 3 步），由部署工作流写入 Worker——不要在 Cloudflare 控制台配置它们。可选变量 `APP_URL` / `RP_ID` / `APP_ORIGIN` 是唯一直接在 Worker 本体上配置的项（Workers & Pages → Hop → Settings → Variables and Secrets），`wrangler.toml` 中的 `keep_vars = true` 确保跨部署保留。

| 变量 | 类型 | 必填 | 来源 | 描述 |
|---|---|---|---|---|
| `APP_URL` | 变量 | 否 | Worker（控制台） | 规范基础 URL（例如 `https://go.example.com`）。可选——未配置时用请求 origin（用于 CORS、HSTS、refresh cookie 的 `Secure` 标记与 `/404` 跳转）。 |
| `RP_ID` | 变量 | 否 | Worker（控制台） | WebAuthn 依赖方 ID（不含协议的域名）。可选——未配置时用请求 hostname。 |
| `APP_ORIGIN` | 变量 | 否 | Worker（控制台） | WebAuthn 来源（完整 URL）。可选——未配置时用请求 origin。 |
| `TABLE_PREFIX` | 变量 | 否 | GitHub `TABLE_PREFIX` → CI | 所有 D1 表名的三态前缀。未配置 → 默认 `hop`（`hop_users`、`hop_links` 等）；自定义值 → 该值（保留大小写）；GitHub 中为 `none` → 显式空、无前缀。在第一次部署前设定一次 — 之后更改需手动重命名所有表。只使用字母数字和下划线字符。 |
| `JWT_SECRET` | 密钥 | 是 | GitHub Secret → CI | HS256 签名密钥，≥ 32 字符 |
| `TOTP_ENCRYPTION_KEY` | 密钥 | 是 | GitHub Secret → CI | 来自 `openssl rand -hex 32` 的十六进制字符串 |
| `SETUP_SECRET` | 密钥 | 是 | GitHub Secret → CI | 通过 HTTP 触发数据库迁移的密钥路径 |
| `WAKER_SIGNING_KEY` | 密钥 | 否 | GitHub Secret → CI | hop 项目的回调签名密钥，建项目时一次性展示。有值 → 部署注入，`/_waker/execute` 验签后执行清理；无值 → 部署照常成功，回调回 500 `signing_key_missing`。见 [夜间清理：由 waker 独驱动](#夜间清理由-waker-独驱动)。不进日志、不进仓库。 |

---

## 设置（管理面板）

| 键 | 值 | 描述 |
|---|---|---|
| `registration_enabled` | `true` / `false` | 允许新用户注册（默认：`false`） |
| `require_email_verification` | `true` / `false` | 要求新用户在登录前验证其邮箱地址（默认：`false`） |
| `app_name` | 字符串 | 界面、邮件与通行密钥提示中显示的应用名称，默认 `Hop`。没有对应的环境变量——本设置是唯一来源。 |
| `email_provider` | `resend` / `smtp` | 使用哪个邮件后端（默认：`resend`） |
| `resend_api_key` | 字符串 | Resend API 密钥 |
| `email_from_domain` | 域名 | Resend 的发件人域名，例如 `example.com` |
| `email_from_name` | 字符串 | Resend 的发件人显示名称 |
| `smtp_host` | 主机名 | SMTP 服务器主机名 |
| `smtp_port` | `587` / `465` / … | SMTP 端口 — 465 为隐式 TLS，587 为 STARTTLS |
| `smtp_from` | 邮件地址 | 发件人地址，例如 `noreply@example.com` |
| `smtp_user` | 字符串 | SMTP 用户名（留空则使用未认证中继） |
| `smtp_pass` | 字符串 | SMTP 密码（存储在 D1 中） |
| `setup_page_enabled` | `0` / `1` | 显示（`1`）或隐藏（`0`）setup 页面；只影响页面可见性，绝不关闭 `POST /api/setup` 迁移通道 |

保存邮件提供商配置后，可用「发送测试邮件」（`POST /api/admin/email/test`）验证配置是否可用。

---

## 许可证

[MIT](./LICENSE)
