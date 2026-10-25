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
| `TABLE_PREFIX` | Variable | No | Three-state table prefix. Unset → default `sl` (`sl_users`, `sl_links`, …). A custom value → that value, case preserved, `[^a-zA-Z0-9_]` stripped. Explicit empty string → no prefix (deployer accepts the table-collision risk). Set **before** first setup and never change it once data exists. |
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

The Deploy workflow applies migrations automatically **before** deploying the code.
Without a prefix it uses `wrangler d1 migrations apply` as before. With `TABLE_PREFIX`
set it applies the migrations from `apps/worker/src/lib/migrations.ts` (the same ones
the setup route runs), skips those already recorded in `_<prefix>_schema_migrations`,
and prints the planned migrations in the log. Migrations must stay backward compatible:
only add tables, indexes or columns — never drop, rename or rewrite existing data.

GitHub Actions cannot distinguish an unset `vars.TABLE_PREFIX` from an empty one, so
the deploy workflow resolves it to the three runtime states: **unset or empty → `sl`**
(the default), **`none` → explicit empty string** (no prefix), **anything else → as-is**.

> **Upgrade warning** — a legacy deployment that never set a prefix used unprefixed
> tables. If the resolved prefix differs from the prefix the database was initialised
> under, setup and migrations **abort with an error** instead of silently switching to
> a different (usually empty) set of tables. Configure `TABLE_PREFIX` to its previous
> value (`TABLE_PREFIX=''`, or `TABLE_PREFIX=none` in CI, to keep unprefixed tables)
> before upgrading.

When using a prefix, set `TABLE_PREFIX` under the GitHub **production environment →
Variables** to exactly the same value as the Worker's `TABLE_PREFIX` **plain-text
variable** in Cloudflare (e.g. `SL`; letters, digits and underscores only). Do not store
it as a secret, and do not change it once data exists. The GitHub `APP_URL` variable must
point at the production URL. `CLOUDFLARE_API_TOKEN` needs edit access to the D1 database
and edit/version-read access to the Worker.

You no longer need to call the setup endpoint after each deploy. For manual
deployments or emergencies it can still be triggered with a `POST` request carrying the
setup secret in a JSON body (the legacy `X-Setup-Secret` header still works, and the
secret is no longer accepted in the URL):

```
curl -X POST https://your-worker.workers.dev/api/setup \
  -H "Content-Type: application/json" \
  -d '{"secret": "<SETUP_SECRET>"}'
```

Response on success:
```json
{
  "migrations": [
    { "name": "schema_v1", "status": "applied" }
  ]
}
```

Re-running it is safe — already-applied migrations return `"skipped"`. The endpoint is
rate-limited to 3 attempts per IP per 10 minutes (once exceeded it returns `429` with a
`Retry-After` header). `GET /api/setup/state` reports `{ "enabled": true | false }` based
on the `setup_page_enabled` setting (defaults to enabled when unset); it only hides the
setup page, it does not disable the `POST` migration channel. When logged in as an admin,
migrations can also be run from the admin panel via `POST /api/admin/setup` — no setup
secret needed, not IP rate-limited, and each run is written to the audit log.

The initialization page itself is served by the SPA at `/setup` (not an API route).

After deploying, the workflow first confirms through the Cloudflare API that the uploaded
version serves 100% of production traffic, then probes the public URL. A `403` carrying
`cf-mitigated: challenge` (e.g. Bot Fight Mode challenging the CI runner) only produces a
warning, since the HTTP/database check could not run; any other non-2xx status or an
unexpected JSON body fails the deploy. Bot Fight Mode can stay enabled.

### 7. First login

Navigate to your deployed URL and register — the first account is automatically granted admin role, regardless of the `registration_enabled` setting. Then go to **Admin → Settings** to configure your email provider.

---

## Local Development

```bash
# 1. Create apps/worker/.dev.vars
cat > apps/worker/.dev.vars << 'EOF'
APP_URL=http://localhost:8787
APP_NAME=ShortLink
RP_ID=localhost
APP_ORIGIN=http://localhost:5173
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
| POST | `/api/admin/setup` | Run schema migrations as admin (no setup secret; writes an audit log) |

### Setup (unauthenticated)

| Method | Path | Description |
|---|---|---|
| GET | `/api/setup/state` | Public — `{ "enabled": true \| false }` from `setup_page_enabled` |
| POST | `/api/setup` | Run schema migrations; JSON body `{"secret": "<SETUP_SECRET>"}` (legacy `X-Setup-Secret` header also works), 3 attempts / IP / 10 min |

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
| `TABLE_PREFIX` | Var | No | Three-state prefix for all D1 table names. Unset → default `sl` (`sl_users`, `sl_links`, …); custom value → that value (case preserved); explicit empty → no prefix. Set once before the first migration — changing it later requires renaming tables. Only alphanumeric and underscore characters are used. |
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
| `setup_page_enabled` | `0` / `1` | Show (`1`) or hide (`0`) the setup page; only affects page visibility, never the `POST /api/setup` migration channel |

After saving your email provider configuration, use **Send test email** (`POST /api/admin/email/test`) to verify it works.

---

## License

[MIT](./LICENSE)
