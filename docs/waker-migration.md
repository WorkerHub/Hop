# hop → waker 迁移：Stage 1 读码核实与实现计划

> 本文件是 Stage 1 的交付物：只读核实 hop 现有定时清理与迁移账本，冻结后续实现单的三个决策（注册路线、档位、`misfirePolicy`）与施工口径。
> 依据：`waker-migration-spec.md`（用户落盘的唯一规格）、waker 平台 `SPEC.md` §2（CF 方言）/ §4（回调协议 v2）/ §5（下游接入形态）、someday 接入 waker 的实现（原 post #564）。
> 本阶段不改任何代码；实现与验收由后续两张单执行，合并、部署、切换、凭据发放均为用户关口。

## 0. 结论摘要

| 待定项 | 结论 | 一句话理由 |
| --- | --- | --- |
| 任务注册路线 | **乙**：用户在 waker 管理面建 `hop` 项目与 `nightly-cleanup` 任务各一次；hop 侧只配 `WAKER_SIGNING_KEY` | 凭据只剩一把（验签 key 两条路线都要），部署链不依赖 waker 可用性，单任务漂移面小 |
| 定档 | **复杂档**（确认，不降） | 同时命中四类禁区：对外 API 与鉴权、定时任务、构建与部署配置、schema 与迁移 |
| `misfirePolicy` | **skip** | 清理判据是绝对时间且幂等，错过一次由下次运行自然补齐；补跑只会多一次无收益的全表扫描 |

三条决策的完整理由见第 2 节；逐项读码结论见第 1 节；施工口径见第 3、4 节。

## 1. 读码核实

### 1.1 `scheduled()` 的完整职责

代码位置：`apps/worker/src/index.ts:161-179`。`scheduled()` 与 `fetch` 同属默认导出，只有一条清理路径，**共 2 条语句，在同一个 `DB.batch` 里**：

| # | 清理对象 | 判据 | 说明 |
| --- | --- | --- | --- |
| 1 | `${prefix}verifications` | `expires_at < unixepoch()` | 过期的一次性验证码/重置码/邮箱验证码（`type` ∈ `email_otp` / `password_reset` / `email_verify`，见 `src/lib/migrations.ts:104-114`） |
| 2 | `${prefix}totp_used` | `used_at < unixepoch() - 90` | TOTP 防重放记录，保留 **90 秒**（不是 90 天）；表以 `(user_id, code)` 为主键（`src/lib/migrations.ts:144-150`） |

核实要点：

- 前缀一律经 `tbl(env, ...)` 派生（`src/lib/db.ts:8-10`），没有写死表名。
- 没有 `ctx.waitUntil`、没有 `try/catch`，`_ctx` 未使用：任一条失败都会让整次 cron 调用以失败告终（Cloudflare 记录该次触发失败），不会静默吞掉。
- 两条语句之外没有任何清理：`links.expires_at` 在读取时判定（`src/routes/redirect.ts:81`），`click_logs` / `audit_logs` 没有保留期策略，全仓没有针对它们的删除语句。迁移时**不得顺手增加**这些清理，保持职责等价。
- 读取侧不含时间过滤的只有 `totp_used`：唯一读它的业务代码是登录二步验证里的 `INSERT OR IGNORE`（`src/routes/auth.ts:1012`），冲突即判「验证码已用过」。因此第 2 条清理的语义是「行存在期间该 6 位码一直被拒」，不是「90 秒后码失效」——跳过一天只是让旧行多留一天，下一次运行按绝对时间判据全部清掉，方向仍是失败关闭。
- 第 1 条清理纯属存储卫生：所有验证码读取都带 `expires_at > ?2`（`src/routes/auth.ts:404、1092、1395、1914、2068`），过期行留着也不会被接受。

### 1.2 cron 表达式

全仓只有 **一条** cron 表达式 `0 3 * * *`：

- `apps/worker/wrangler.toml:30-31` 的 `[triggers] crons = ["0 3 * * *"]`；
- 代码注释 `src/index.ts:164` 与 `CLAUDE.md:158` 均指同一条；
- 没有第二条触发器，也没有 Queue consumer（`wrangler.toml` 无 `[[queues]]`，入口只导出 `fetch` / `scheduled`）。

时区语义：Cloudflare cron 按 UTC 解释，`0 3 * * *` = UTC 03:00 = 北京时间 11:00，与现状一致。迁移后任务 `timezone` 显式写 `UTC`，表达式逐字不改（waker 复用同一套 CF 方言解析器，零改写）。

### 1.3 `[triggers]` 现状与部署流水线的注入方式

- 现状：`apps/worker/wrangler.toml:30-31` 保留一个 `[triggers]` 段，仅此一处。
- 部署流水线**完全不读写** `[triggers]`：`.github/workflows/deploy.yml` 里没有任何 triggers 处理，只有工作流自身触发条件的注释。它做的是：
  1. 解析 `TABLE_PREFIX` 三态（`deploy.yml:61-68`）；
  2. 用 `sed` 替换 5 个占位符：`D1_DATABASE_ID` / `D1_DATABASE_NAME` / `KV_NAMESPACE_ID` / `CLOUDFLARE_ACCOUNT_ID` / `TABLE_PREFIX`，并校验没有残留 `_PLACEHOLDER`（`deploy.yml:70-100`）；
  3. 构建 → 迁移（`apply` 或 `prefixed` 两种模式，`deploy.yml:104-133`）→ 写 secrets 文件（`deploy.yml:139-166`）→ `wrangler deploy --secrets-file`（`deploy.yml:177-182`）→ 校验部署（`deploy.yml:186-193`）→ 冒烟（`deploy.yml:199-206`）。
- `wrangler deploy` 会按配置同步 schedules：配置里有 `[triggers]` 就部署这条 cron，整段删掉就没有 cron。同一平台的既有先例是 someday 的 ONE-584（提交 `de956c1`：删除整个 `[triggers]` 段，触发单一化为 waker 回调），本方案沿用同一机制。
- `keep_vars = true`（`wrangler.toml:6`）只保证「配置里没写的 vars 不被删除」，**不管 cron**，也意味着上一次部署写进去的 `WAKER_MODE` 会在回滚后继续存活——所以部署脚本必须每次都显式写一个值，见 4.2。
- 现有 `verify-deployment.sh` 断言的是：上传版本 id、三个 secret 绑定（`JWT_SECRET` / `SETUP_SECRET` / `TOTP_ENCRYPTION_KEY`，`verify-deployment.sh:40-49`）、版本 100% 流量、`TABLE_PREFIX` 一致；**没有**断言 cron 计划。迁移需要在同一脚本补一条 schedules 断言，否则「triggers 真的没了」只能靠人看仪表盘。

### 1.4 迁移账本现状与 executionId 去重

**表前缀三态**（`src/lib/table-prefix.ts:8-19`）：

| `TABLE_PREFIX` | 生效前缀 | 示例表名 |
| --- | --- | --- |
| 未配置（`undefined`） | `hop`（代码默认，`DEFAULT_TABLE_PREFIX`，`table-prefix.ts:13`） | `hop_users` |
| 显式空字符串 | 无前缀 | `users` |
| 其他值 | 原样（仅剥除 `[^a-zA-Z0-9_]`，大小写保留） | `SL_users` |

**迁移 runner 与双通道**：

- 单一真源是 `src/lib/migrations.ts` 的 `getMigrations(prefix)`（`migrations.ts:39-163`），当前 `schema_v1`（`0001_init.sql`）与 `schema_v2`（`0002_token_version.sql`）。
- 有前缀的部署走 `d1-prepare-migrations.sh` → `mode=prefixed`（`d1-prepare-migrations.sh:88-108`）→ `d1-prefixed-migrations.sh` 直接执行 `getMigrations(prefix)` 的语句并把名字写进 `_<prefix>_schema_migrations`（`d1-prefixed-migrations.sh:158-173`）。`d1-migrations.mjs:34-39` 只放行四类加法语句（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `ALTER TABLE … ADD` / `INSERT OR IGNORE`），并校验写入与 `REFERENCES` 的表都带本前缀。
- 无前缀的部署走 `wrangler d1 migrations apply`，账本是数据库级的 `d1_migrations`，文件由 `scripts/generate-migrations.ts:27-42` 从同一份 `getMigrations('')` 生成（生成时剥掉 `IF NOT EXISTS`，保留 wrangler 的「重复即报错」语义）。`test/migrations.test.ts:20-33` 断言磁盘文件与生成内容一致。
- 同一 runner 也服务 `POST /api/setup` 与管理面「检查并升级数据库」（`src/lib/migrations-runner.ts:172-218`），所以新增迁移对三条入口同时生效。

**executionId 去重：必须新增一张表**，不能复用现有表：

- 现有表没有任何 `execution_id` 语义；把列塞进 `users` / `verifications` 之类业务表会把清理数据与鉴权数据耦在一起，也违反共享 D1「只动本项目的表」的规矩。
- waker SDK 的账本要求 `execution_id` 为主键、用 `INSERT … ON CONFLICT(execution_id) DO NOTHING` + `meta.changes` 原子认领（SDK `client/src/ledger.ts:187-218`），现有业务表给不了这个语义。
- 结论：新增 `${t('waker_executions')}`，默认落到 `hop_waker_executions`；列与 SDK 的 `executionLedgerDdl()`（`client/src/ledger.ts:79-90`）逐列一致，以 `schema_v3` / `0003_waker_executions.sql` 的形式加入账本：

```sql
CREATE TABLE IF NOT EXISTS ${t('waker_executions')} (
  execution_id   TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  job_name       TEXT NOT NULL,
  scheduled_for  INTEGER NOT NULL,
  status         TEXT NOT NULL,
  response_json  TEXT,
  claimed_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
```

写法约束：

- 只允许这一条 `CREATE TABLE IF NOT EXISTS`，不加索引：账本的所有查询都以 `execution_id` 主键进入（认领、读回放、接管、完成、释放），没有按 `claimed_at` 的范围扫描。
- 表名必须经 `tbl()` 派生：测试环境 `TABLE_PREFIX=''` 下是 `waker_executions`，生产默认是 `hop_waker_executions`。
- 迁移一旦合并即不可再改（账本按名字记账）；SDK 日后改 DDL 也不得回改本历史项（someday 的 `worker/src/db/migrations.ts` 对同一张表采用同样的冻结写法）。
- 加 `schema_v3` 会连带影响三处硬编码清单：`test/migrations-runner.test.ts`（55-60、163-164、184-185、193 行）、`test/setup.test.ts`（110-111 行）、`.github/scripts/test-d1-migrations.mjs`（236-247、274-306、334-364、399-403 行）；`WRANGLER_MIGRATION_FILES` 由 `migrations.ts:180-182` 自动派生，不用手改。
- `Hop_UNIQUE_SUFFIXES`（`src/lib/migrations-runner.ts:42`）只用于识别已存在的前缀 schema，新增表不需要登记。

## 2. 三条决策

### 2.1 任务注册路线：乙

**做法**：用户在 waker 管理面建项目 `hop`（回调地址填 hop 的公网根地址）与 cron 任务 `nightly-cleanup` 各一次；hop 仓库只配 `WAKER_SIGNING_KEY` 一个 secret，部署时经既有 `--secrets-file` 通道注入。

**理由**：

1. **凭据面更小**。signing key 是两条路线都必须有的（hop 验签用）；甲额外要求把项目令牌放进 GitHub Secrets，而项目令牌能创建/取消任务，权限比验签 key 高。hop 只有一个固定任务，自动化换不来额外能力，却多一把长期凭证和一次轮换关口。
2. **发布链解耦**。甲意味着每次生产部署都要调 waker 注册 API：平台不可用、令牌失效都会让 hop 的部署失败。乙的部署路径与今天一致，只多一个 secret 绑定校验。
3. **漂移可控且可见**。只有一个任务、表达式固定；任务名/表达式/策略在本文件冻结，代码侧以常量单点声明。真发生漂移时表现明确：任务名不符 → 回调 404 `unknown_job`；任务不存在 → executions 页为空，都不是静默错误。
4. **与落地参照一致**。someday 接入 waker（原 post #564）走的就是乙，验收与排障经验可直接复用。

**甲被排除的理由**（记录备查）：甲把 cron 与策略纳入代码评审、可自动对账，代价是把项目令牌写进 CI 并让部署依赖平台可用性。对「单个每日清理任务」不划算。若日后 hop 出现第二个以上定时任务、或任务参数需要频繁变更，再评估切到甲。

### 2.2 定档：复杂档（确认）

读码后逐项命中禁区，维持复杂档，不降：

| 禁区 | 在本次迁移中的落点 |
| --- | --- |
| 对外 API 契约与鉴权 | 新增对外入口 `/_waker/execute`；HMAC-SHA256 覆盖 `timestamp + executionId + jobId + rawBody`，300 秒时间窗，每项目独立 signing key；未配 key 时失败关闭（500 `signing_key_missing`） |
| 定时任务 | 每日清理从 CF Cron Trigger 迁到平台回调；`[triggers]` 的摘除改变调度来源 |
| 构建与部署配置 | `[triggers]` 条件摘除、`[vars]` 注入、secrets 文件增加绑定、部署校验增加断言 |
| 数据库 schema 与迁移 | 新增 `hop_waker_executions` 表与 `schema_v3` 账本记录，走共享 D1 的加法迁移 |

其中鉴权与 schema 是硬禁区；按「只升不降」，复杂档成立。规格里「至多中等档」的预判按 Chief 定档与禁区命中被覆盖，不是代码冲突。

### 2.3 `misfirePolicy`：skip

waker 的三种取值定义在平台 `src/do/types.ts:46-51`，补跑判定在 `src/do/policies.ts:38-68`（迟到超过 60 秒才算错过）。

**选 `skip` 的理由**：

1. **判据是绝对时间，补跑无正确性收益**。`expires_at < unixepoch()` 与 `used_at < unixepoch() - 90` 都是「删掉此刻已经不该留的行」，错过一次不会漏删：下次运行这些行仍然满足判据，一条不少。
2. **`fire_once` 只会制造噪声**。它会在恢复后立刻补一次，把「每天 03:00 一次」变成「某天两次、其中一次时刻随机」，多一次全表扫描和一条无信息量的执行记录；验收单对比 cron 与 waker 计数时也更容易混。
3. **`fire_all` 明确排除**。长故障后连发多次，对清理类任务毫无意义。
4. **跳过一天的影响有界且自愈**。过期验证码本来就不会被读取接受；`totp_used` 多留一天只是让对应 6 位码多被拒一天（失败关闭方向），下一次运行按绝对判据清干净。
5. **双跑窗口更干净**。cron 与 waker 在同一分钟各跑一次时，`skip` 不会因为 alarm 抖动再叠加补跑。

## 3. 后续实现单施工图

### 3.1 运行形态

- **两个入口、一份业务逻辑**：`scheduled()` 与 `POST /_waker/execute` 都调用同一个 `runCleanup(env)`；禁止写两套删除语句，也禁止在回调里 `waitUntil + 立即 200`。
- **双模式默认关闭**：`WAKER_MODE` 缺省或取值不认识一律按 `cron`；且 `WAKER_URL` 为空时 receiver 不启用（用户规格的自动关闭口径）。原生模式不构造注册客户端、不改 `scheduled()` 行为。
- **回调挂载**：`app.route('/_waker', …)`，平台打 `POST /_waker/execute`；必须在 `/:slug` 短链路由与 SPA 兜底 `app.all('*')` 之前注册。
- **非 waker 模式显式 404**：`/_waker/*` 在 cron 模式下必须返回 404 JSON。原因见 3.3 第一条。

### 3.2 文件清单

| 文件 | 动作 |
| --- | --- |
| `apps/worker/src/waker/`（7 个 `.ts` + `README.md`） | 从 waker 仓 `client/src/` 逐字拷贝 SDK（`protocol` / `verify` / `ledger` / `receiver` / `client` / `modes` / `index`），README 记来源与 commit；本目录不手改，升级整目录重拷 |
| `apps/worker/src/services/cleanup.ts` | 新增：抽出 1.1 的两条删除为 `runCleanup(env)`，返回 `{ verifications, totpUsed, durationMs }`，每次运行打一行 JSON 日志（`source` / `executionId` / 计数 / 耗时，不含凭据与载荷） |
| `apps/worker/src/services/waker.ts` | 新增：冻结任务名 `nightly-cleanup`、表达式 `0 3 * * *`、时区 `UTC`；`wakerEnabled(env)`（模式 + URL 双条件）；按请求组装 receiver（jobs → `runCleanup`，ledger → D1 账本，`onJobError` 打日志） |
| `apps/worker/src/index.ts` | `scheduled()` 改为委托 `runCleanup`；在短链与 SPA 兜底之前挂 `/_waker`；非 waker 模式返回 404 `waker_disabled` |
| `apps/worker/src/lib/migrations.ts` | 追加 `schema_v3`（1.4 的 DDL，`IF NOT EXISTS` 形式） |
| `apps/worker/migrations/0003_waker_executions.sql` | 由 `pnpm --filter @hop/worker generate:migrations` 生成，不手写 |
| `apps/worker/src/types.ts` | `WAKER_MODE?`、`WAKER_URL?`、`WAKER_SIGNING_KEY?`（均为可选；key 只来自 secret） |
| `.github/scripts/configure-waker-mode.mjs` | 新增：按 4.2 的规则改写 `wrangler.toml`，供部署与本地测试共用 |
| `.github/workflows/deploy.yml` | 在「Inject resource IDs」后插入「Configure waker mode」；secrets 文件按模式要求 `WAKER_SIGNING_KEY` |
| `.github/scripts/verify-deployment.sh` | waker 模式断言 `WAKER_SIGNING_KEY` 绑定；按模式断言 cron schedules 数量 |
| `apps/worker/test/waker.test.ts`、`apps/worker/test/cleanup.test.ts` | 新增：验签正/负例、幂等重放、清理判据与计数 |
| `apps/worker/test/migrations-runner.test.ts`、`apps/worker/test/setup.test.ts`、`.github/scripts/test-d1-migrations.mjs` | 更新 1.4 列出的硬编码迁移清单 |
| `.github/scripts/test-deploy-checks.mjs` | 增加模式改写的用例（默认 cron、双跑、切换、非法组合） |
| `README.md` | 双模式部署说明（项目/任务建法、变量、切换顺序）与回滚步骤 |

### 3.3 关键实现约束

- **回调 receiver 用 `createWakerReceiver` 逐请求构造**，不用 `mountWakerReceiver`：hop 的 `app` 是模块级单例，`mountWakerReceiver` 在缺 signing key 时会**构造期抛错**，等于整个 Worker（含 cron）起不来；`createWakerReceiver` 是每请求失败关闭（500 `signing_key_missing`），与规格口径一致。现成参照是 someday 的 `worker/src/routes/waker-callback.ts`（宿主 Hono + 按请求构造）。
- **账本表名**：`createD1ExecutionLedger(env.DB, { table: tbl(env, 'waker_executions') })`，不写死前缀。
- **清理计数**：两条删除改用两次 `prepare().run()` 读 `meta.changes`（而不是 `DB.batch`），因为账本化后的可观测要求计数，而测试用的内存 D1 mock 的 `batch()` 不返回 `meta`（`test/helpers/env.ts:103-105`）。删除对象与判据不变；两条语句彼此独立且幂等，失去 batch 原子性不会造成不一致（失败的那条下次运行补上）。
- **cron 模式下 `/_waker/execute` 必须 404**：该路径目前会落到 SPA 兜底，`not_found_handling = "single-page-application"` 会对未知路径返回 **200 HTML**；若 waker 侧任务先于 receiver 生效而存在，平台会把「没执行」记成成功。显式 404 让误序切换立刻暴露。
- **幂等**：`executionId` 由 SDK 账本去重，重复投递回 2xx + `duplicate:true` + 首次响应回放；清理本身重跑为无操作（两条都删 0 行）。
- **slug 不冲突**：`app.get('/:slug')` 只吃单段路径，`/_waker/execute` 是两段，不会被短链路由截走；不需要改 `RESERVED_SLUGS`。
- **超时与重试**：清理只是两条 DELETE，`timeoutSeconds=30`（平台默认）、`maxRetries=2`、`backoffSeconds=60`；`concurrency=forbid` 由规格冻结。

## 4. 部署状态、关口顺序与回滚

### 4.1 三个部署状态

| 状态 | `WAKER_MODE` | `WAKER_TRIGGERS` | 部署后 |
| --- | --- | --- | --- |
| 原生（默认 / 回滚） | `cron` | `keep` | receiver 不启用，cron 保留，行为与迁移前一致 |
| 双跑 | `waker` | `keep` | receiver 生效，cron 仍在（验收要求的并行观察窗口） |
| 切换完成 | `waker` | `remove` | 无 cron，平台是唯一触发源 |

「双模式」是运行模式（`WAKER_MODE`）；`[triggers]` 的摘除是**切换动作**（`WAKER_TRIGGERS`），两者解耦，否则无法产生验收要求的 ≥1 个完整日周期并行窗口。最终态与实现单「waker 模式无 `[triggers]`」的口径一致。

### 4.2 部署期改写规则（`configure-waker-mode.mjs`）

- 三个 GitHub Actions **variables**：`WAKER_MODE`（`cron` 默认 / `waker`）、`WAKER_URL`（waker 模式必填，`https://` 开头）、`WAKER_TRIGGERS`（`keep` 默认 / `remove`）。
- 每次部署都显式写入 `WAKER_MODE = "<值>"`。原因：`keep_vars = true` 会让上一次 waker 模式写入的值在回滚后继续存活，不显式覆盖就回不到原生模式。
- `waker` 模式追加 `WAKER_URL`；`cron` 模式不写 `WAKER_URL`（残留值无害，模式门控在先）。
- 仅当 `WAKER_MODE=waker` 且 `WAKER_TRIGGERS=remove` 时删除整个 `[triggers]` 段；`remove` + `cron` 的组合直接报错退出，避免「cron 被删但 receiver 没开」的窗口。
- 其他情况不改 `[triggers]`，`cron` 模式除多一行 `WAKER_MODE="cron"` 外与今天的配置一致。
- **secret**：`WAKER_SIGNING_KEY` 仅在 waker 模式必填（secrets 文件步骤失败关闭并点名缺哪把 key），cron 模式可缺省；`verify-deployment.sh` 只在 waker 模式断言该绑定。密钥值只从 GitHub Secrets 进 `$RUNNER_TEMP/secrets.json`（0600），不进仓库、不进日志。

### 4.3 关口顺序（★ = 用户关口）

1. ★ **计划关口**：用户确认本文件（三条决策 + 施工口径），放行实现单。
2. ★ **合入并部署**：实现单合入 `main`，按原生状态部署（`WAKER_MODE=cron` / `WAKER_TRIGGERS=keep`），行为与迁移前一致。
3. ★ **建项目**：waker 管理面建项目 `hop`，回调地址填 hop 的公网根地址（平台执行期拼 `/_waker/execute`）。此步只建项目、**不建任务**：任务一旦存在就会按 cron 开始投递，而 receiver 还没上线。
4. ★ **凭据发放**：建项目时一次性展示的 signing key 先存密码管理器留底，再存 GitHub Secret `WAKER_SIGNING_KEY`；不得用新生成的值顶替任何在用密钥。
5. ★ **部署（双跑）**：`WAKER_MODE=waker` + `WAKER_TRIGGERS=keep` → 部署 → 确认 `POST /_waker/execute` 已由 receiver 处理：无签名头回 400 `invalid_request`（SPA 兜底会给 200 HTML），带签名头但签名不对回 401；两者都不能是 200 HTML。
6. ★ **建任务**：在 waker 管理面建并启用 `nightly-cleanup`，参数照抄第 2.1 / 2.3 节与本表；随后观察 ≥1 个完整日周期（验收单执行）。

   | 字段 | 值 |
   | --- | --- |
   | 任务名 | `nightly-cleanup`（必须与代码常量逐字一致） |
   | cron | `0 3 * * *` |
   | timezone | `UTC` |
   | `misfire` | `skip` |
   | `concurrency` | `forbid` |
   | `maxRetries` / `backoffSeconds` / `timeoutSeconds` / `jitterSeconds` | `2` / `60` / `30` / `0` |

7. ★ **切换**：`WAKER_TRIGGERS=remove` → 部署 → 确认该 Worker 的 schedules 为空。
8. ★ **回滚**（任意时刻）：`WAKER_TRIGGERS=keep` + `WAKER_MODE=cron` → 部署 → 在 waker 管理面暂停任务。迁移是纯加法（只新增 `hop_waker_executions`），回滚不需要动数据；重复清理幂等，双跑不会产生重复副作用。

## 5. 验证与自测

本阶段（只读）的验证：

- `git diff --stat origin/main...HEAD` 只出现本文件，证明没有代码改动。
- 逐条复核第 1 节：`sed -n '161,179p' apps/worker/src/index.ts`、`grep -n crons apps/worker/wrangler.toml`、`grep -c triggers .github/workflows/deploy.yml`（期望 0）、`grep -n DEFAULT_TABLE_PREFIX apps/worker/src/lib/table-prefix.ts`、`grep -n 'IF NOT EXISTS' apps/worker/src/lib/migrations.ts`。
- `pnpm check && pnpm typecheck && pnpm test` 结果与改动前一致（文档不影响构建）。

实现单的自测命令（写入交付汇报，逐项对验收标准）：

```bash
pnpm --filter @hop/worker test          # 验签正负例 / 幂等重放 / 清理判据与计数 / 迁移
pnpm check && pnpm typecheck && pnpm test
node --test .github/scripts/test-d1-migrations.mjs .github/scripts/test-deploy-checks.mjs
pnpm --filter @hop/worker generate:migrations && git diff --exit-code apps/worker/migrations
```

验收单在真实环境核对：手动触发一次（验签通过、计数与原生 `scheduled()` 同数据一致）、篡改签名/过期时间戳被拒、同一 `executionId` 重放无副作用、双跑 ≥1 日无重复副作用、触发延迟分钟级、凭据零泄露、两种模式部署产物与 schedules 符合第 4.1 节。

## 6. 冲突核查与不做的事

- **规格与代码现状：无冲突**，不需要上报改口径。两处需要写明的澄清：
  1. 走注册路线乙时不存在注册客户端，`WAKER_URL` 只作模式开关与日志标识（不发起任何平台请求）；将来改走甲时再补客户端。
  2. 规格预判「至多中等档」与 Chief 定档的复杂档不矛盾：按禁区命中只升不降，代码现状支持复杂档（第 2.2 节）。
- **本文件不做**：不改清理业务规则（对象、判据、频率）、不动短链/账号/统计等其他功能、不改 waker 平台本体、不做 one-shot 任务与 Service Binding 鉴权、不新增 click/audit 保留期清理。
