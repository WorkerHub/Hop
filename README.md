# ShortLink

[中文](./README.zh-CN.md)

A self-hosted URL shortener built entirely on Cloudflare's platform. No servers to manage — runs on Workers, D1 (SQLite), and KV.

## Features

- **Short links** — random 4-char slugs or custom aliases
- **Click analytics** — country, device, browser, OS, referrer tracking via Cloudflare geo headers
- **Multi-user** — registration can be open or invite-only; first registered user becomes admin
- **Three 2FA methods** — TOTP (authenticator app), Passkey (WebAuthn), Email OTP
- **Admin panel** — manage users, view all links, configure global settings
- **Link expiry** — set expiry by date or number of days
- **Zero egress cost** — KV caches redirect lookups; click logging is non-blocking

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | TypeScript + Hono.js on Cloudflare Workers |
| Frontend | React 18 + Vite + shadcn/ui + Tailwind CSS |
| Database | Cloudflare D1 (SQLite) |
| Cache | Cloudflare KV |
| Email | Resend API **or** custom SMTP server (switchable from admin UI) |
| Charts | Recharts + react-simple-maps |
| 2FA | otpauth (TOTP) + @simplewebauthn/server (Passkey) + Email OTP |

## Deployment

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com)

### 1. Fork this repository

Fork this repository to your own account or organization.

### 2. Create Cloudflare resources

Create the following resources in Cloudflare, please note their IDs for the next step.

| Resource | Name |
|---|---|
| Workers KV | `LINKS_KV` (customizable)|
| D1 SQL databases | `shortlink` (customizable) |


### 3. Add GitHub Actions secrets

In your GitHub repository go to **Settings → Secrets and variables → Actions** and add:

Repository secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token created with the **Edit Cloudflare Workers** template from the [User API Tokens](https://dash.cloudflare.com/profile/api-tokens) page |

Repository variables:

| Variable | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID (visible in the Cloudflare dashboard URL) |
| `KV_NAMESPACE_ID` | Workers KV ID from the previous step |
| `D1_DATABASE_ID` | D1 database ID from the previous step |
| `D1_DATABASE_NAME` |(Configure as needed) If you customized the D1 database name in the previous step, you must configure it with the corresponding name; otherwise, no configuration is required |

The deploy workflow (`.github/workflows/deploy.yml`) injects these IDs into `wrangler.toml` at deploy time via `sed`, so no IDs are ever committed to the repository.

### 4. Configure variables and secrets

Go to [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages → shortlink → Settings → Variables and Secrets** and add:

| Name | Type | Required | Example / Notes |
|---|---|---|---|
| `APP_URL` | Variable | Yes | `https://yourdomain.com` |
| `APP_NAME` | Variable | Yes | `ShortLink` — default app name, overridable in admin UI |
| `RP_ID` | Variable | Yes | `yourdomain.com` — WebAuthn relying party ID (domain only) |
| `APP_ORIGIN` | Variable | Yes | `https://yourdomain.com` — WebAuthn origin (full URL) |
| `TABLE_PREFIX` | Variable | No | e.g. `sl` — prefixes all D1 table names (`sl_users`, `sl_links`, …). Must be set **before** running the setup route. Leave empty to use unprefixed names. |
| `JWT_SECRET` | Secret | Yes | Any random string ≥ 32 chars |
| `TOTP_ENCRYPTION_KEY` | Secret | Yes | `openssl rand -hex 32` |
| `SETUP_SECRET` | Secret | Yes | `openssl rand -hex 24` — used to trigger migrations |

> `keep_vars = true` is set in `wrangler.toml`, so deployments will never overwrite these values.
>
> Email provider settings (Resend API key, SMTP credentials, etc.) are configured in the **admin UI** after first login — no Cloudflare dashboard config needed.

### 5. Build and deploy

Go to **GitHub Actions → Deploy** and click **Run workflow** to trigger deployment manually.

This will deploy the code to Cloudflare Workers.

### 6. Run database migrations

GitHub Actions 会在部署代码**之前**自动执行迁移：无前缀时仍使用
`wrangler d1 migrations apply`；有前缀时使用与 setup 路由共享的
`apps/worker/src/lib/migrations.ts`，按 `_<prefix>_schema_migrations` 跳过已执行项，
并在日志中打印待执行计划。迁移必须向后兼容，只添加表、索引或列，不删除、重命名或修改现有数据。

使用前缀时，在 GitHub 的 **production environment → Variables** 中设置
`TABLE_PREFIX`，与 Cloudflare Worker 的同名**明文变量**完全一致（例如 `SL`，仅字母、数字和下划线）。
不要把它设为 Secret，也不要在已有数据后更换前缀。GitHub 中的 `APP_URL` 也必须指向生产地址。
现有 `CLOUDFLARE_API_TOKEN` 需要有目标 D1 的编辑权限和 Worker 的编辑/版本读取权限。

无需在每次部署后调用 `/setup`。手动部署或应急操作仍可通过 `POST` 请求触发，
密钥放在请求头中（不再通过 URL 传递）：

```
curl -X POST https://your-worker.workers.dev/setup \
  -H "X-Setup-Secret: <SETUP_SECRET>"
```

Response on success:
```json
{
  "migrations": [
    { "name": "schema_v1", "status": "applied" }
  ]
}
```

重复调用是安全的，已执行的迁移会返回 `"skipped"`。自动部署不需要手动调用。
部署后还会通过 Cloudflare API 核对本次上传的版本承载 100% 流量，再检查公开 URL。
公开 URL 返回带 `cf-mitigated: challenge` 的 403 时仅警告（HTTP/数据库检查未能验证），
其余非 2xx 或错误的 JSON 均失败；无需关闭 Bot Fight Mode。

### 7. First login

Navigate to your deployed URL and register — the first account is automatically granted admin role, regardless of the `registration_enabled` setting. Then go to **Admin → Settings** to configure your email provider.

---

## Local Development

```bash
# 1. Create apps/worker/.dev.vars
cat > apps/worker/.dev.vars << 'EOF'
JWT_SECRET=dev-secret-at-least-32-characters-long
TOTP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
SETUP_SECRET=local-setup-secret
EOF

# 2. Apply migrations to local D1
cd apps/worker && pnpm db:migrate:local && cd ../..

# 3. Start everything
pnpm dev
# Worker: http://localhost:8787
# Web:    http://localhost:5173
```

The Vite dev server proxies `/api` requests to `:8787` automatically.

---

## API Reference

### Authentication

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Register new account |
| POST | `/api/auth/login` | Login; returns tokens or 2FA challenge |
| POST | `/api/auth/logout` | Revoke refresh token |
| POST | `/api/auth/refresh` | Refresh access token |
| GET | `/api/auth/me` | Get current user profile |
| POST | `/api/auth/change-password` | Change password (authenticated) |
| POST | `/api/auth/verify-email` | Verify email address with the code sent on registration |
| POST | `/api/auth/resend-verify-email` | Resend the registration email verification code |
| POST | `/api/auth/forgot-password` | Request password reset code via email |
| POST | `/api/auth/verify-reset-code` | Verify password reset code (without consuming it) |
| POST | `/api/auth/reset-password` | Complete password reset with code and new password |

### 2FA — Verification (requires `pendingToken` from login)

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/2fa/totp/verify` | Complete login with TOTP code |
| POST | `/api/auth/2fa/email-otp/send` | Send email OTP |
| POST | `/api/auth/2fa/email-otp/verify` | Complete login with email OTP |
| POST | `/api/auth/2fa/passkey/verify-options` | Get WebAuthn assertion options |
| POST | `/api/auth/2fa/passkey/verify` | Complete login with passkey |

### 2FA — Setup (requires active session)

| Method | Path | Description |
|---|---|---|
| GET | `/api/auth/2fa/totp/setup` | Get TOTP secret + QR URI |
| POST | `/api/auth/2fa/totp/confirm` | Confirm and enable TOTP |
| DELETE | `/api/auth/2fa/totp` | Disable TOTP |
| POST | `/api/auth/2fa/email-otp/send-verify` | Send verification code to enable email OTP |
| POST | `/api/auth/2fa/email-otp/enable` | Enable email OTP (with verification code) |
| DELETE | `/api/auth/2fa/email-otp` | Disable email OTP |
| GET | `/api/auth/2fa/passkey` | List registered passkeys |
| POST | `/api/auth/2fa/passkey/register-options` | Get WebAuthn registration options |
| POST | `/api/auth/2fa/passkey/register-verify` | Register passkey |
| DELETE | `/api/auth/2fa/passkey/:id` | Remove passkey |

### Links (requires authentication)

| Method | Path | Description |
|---|---|---|
| GET | `/api/links` | List your links (paginated, searchable) |
| POST | `/api/links` | Create link |
| GET | `/api/links/:id` | Get link details |
| PUT | `/api/links/:id` | Update link |
| DELETE | `/api/links/:id` | Delete link |

### Analytics (requires authentication)

| Method | Path | Description |
|---|---|---|
| GET | `/api/analytics/summary` | Aggregated click stats across all user links (query: `days=30`) |
| GET | `/api/analytics/:linkId` | Per-link click analytics |

### Admin (requires admin role)

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/stats` | Dashboard stats |
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users` | Create user (admin-initiated) |
| PATCH | `/api/admin/users/:id` | Update user role/status |
| DELETE | `/api/admin/users/:id` | Delete user |
| GET | `/api/admin/links` | List all links |
| DELETE | `/api/admin/links/:id` | Delete any link |
| GET | `/api/admin/settings` | Get global settings |
| PUT | `/api/admin/settings` | Update global settings |

### Miscellaneous

| Method | Path | Description |
|---|---|---|
| GET | `/api/config` | Public app config (`appName`, `registrationEnabled`) |
| GET | `/api/health` | Health check |

### Redirect

```
GET /:slug  →  302 to destination URL
```

---

## Environment Variables

All variables and secrets are managed in the **Cloudflare dashboard** (Workers & Pages → shortlink-worker → Settings → Variables and Secrets). `keep_vars = true` in `wrangler.toml` ensures deployments never overwrite them.

| Variable | Type | Required | Description |
|---|---|---|---|
| `APP_URL` | Var | Yes | Canonical base URL (e.g. `https://go.example.com`) |
| `APP_NAME` | Var | Yes | Default app name; overridable in admin UI |
| `RP_ID` | Var | Yes | WebAuthn relying party ID (domain without protocol) |
| `APP_ORIGIN` | Var | Yes | WebAuthn origin (full URL) |
| `TABLE_PREFIX` | Var | No | Prefix for all D1 table names (e.g. `sl` → `sl_users`, `sl_links`, …). Set once before the first migration — changing it later requires manually renaming tables. Only alphanumeric and underscore characters are used. |
| `JWT_SECRET` | Secret | Yes | HS256 signing key, ≥ 32 chars |
| `TOTP_ENCRYPTION_KEY` | Secret | Yes | Hex string from `openssl rand -hex 32` |
| `SETUP_SECRET` | Secret | Yes | Secret path for triggering DB migrations via HTTP |

---

## Settings (Admin Panel)

| Key | Values | Description |
|---|---|---|
| `registration_enabled` | `true` / `false` | Allow new user registration (default: `false`) |
| `require_email_verification` | `true` / `false` | Require new users to verify their email before signing in (default: `false`) |
| `app_name` | string | Override displayed app name |
| `email_provider` | `resend` / `smtp` | Which email backend to use (default: `resend`) |
| `resend_api_key` | string | Resend API key |
| `email_from_domain` | domain | Sender domain for Resend, e.g. `example.com` |
| `email_from_name` | string | Sender display name for Resend |
| `smtp_host` | hostname | SMTP server hostname |
| `smtp_port` | `587` / `465` / … | SMTP port — 465 for implicit TLS, 587 for STARTTLS |
| `smtp_from` | email address | Sender address, e.g. `noreply@example.com` |
| `smtp_user` | string | SMTP username (leave blank for unauthenticated relay) |
| `smtp_pass` | string | SMTP password (stored in D1) |

---

## License

[MIT](./LICENSE)
