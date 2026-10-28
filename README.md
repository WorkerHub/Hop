# Hop

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
| D1 SQL databases | `Hop` (customizable) |


### 3. Add GitHub Actions secrets and variables

In your GitHub repository go to **Settings → Secrets and variables → Actions** and add:

Repository secrets (the deploy workflow reads these; `JWT_SECRET`, `SETUP_SECRET` and `TOTP_ENCRYPTION_KEY` are uploaded to Cloudflare as CF Secrets via `--secrets-file`, so they are never configured in the Cloudflare dashboard):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token created with the **Edit Cloudflare Workers** template from the [User API Tokens](https://dash.cloudflare.com/profile/api-tokens) page. Needs edit access to the D1 database, edit/version-read access to the Worker, and Workers Scripts:Read (the smoke test reads the workers.dev subdomain when `APP_URL` is unset). |
| `JWT_SECRET` | Any random string ≥ 32 characters. CI uploads it as a Cloudflare Secret via `--secrets-file`. |
| `SETUP_SECRET` | `openssl rand -hex 24`. CI uploads it as a Cloudflare Secret via `--secrets-file`; used for setup/migrations. |
| `TOTP_ENCRYPTION_KEY` | `openssl rand -hex 32`. CI uploads it as a Cloudflare Secret via `--secrets-file`; encrypts TOTP credentials, so rotating it invalidates every bound TOTP. The deploy fails closed when it is empty or missing. |

> **Migrating an existing deployment to CI** — the GitHub `JWT_SECRET`, `SETUP_SECRET` and `TOTP_ENCRYPTION_KEY` values must be the **same values** as the Cloudflare Secrets already configured on the Worker. Fill in the existing values; never generate new ones to replace them, or CI will overwrite the live secrets with different values (for `TOTP_ENCRYPTION_KEY` that would invalidate every bound TOTP). Once the values live in GitHub, CI owns them: delete the Cloudflare-side copies, because a console edit is overwritten by the next deploy anyway.

Repository variables (the deploy workflow reads these):

| Variable | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID (visible in the Cloudflare dashboard URL) |
| `KV_NAMESPACE_ID` | Workers KV ID from the previous step |
| `D1_DATABASE_ID` | D1 database ID from the previous step |
| `D1_DATABASE_NAME` | (Optional) Only needed if you customized the D1 database name in the previous step; otherwise, no configuration is required |
| `TABLE_PREFIX` | (Optional) Three-state table prefix and the **single source of truth** for the Worker's `TABLE_PREFIX` binding: unset or empty → default `hop`, the reserved word `none` → explicit no prefix, anything else → that value. Every deploy writes it into the Worker binding — never configure it in the Cloudflare dashboard (step 4). |
| `APP_URL` | (Optional) Production URL probed by the smoke test (step 6). When unset, the smoke test resolves and probes the Worker's workers.dev address automatically. Independent of the optional Worker variable of the same name (step 4) — the Worker does not need it. |

The deploy workflow (`.github/workflows/deploy.yml`) injects the resource IDs and the resolved `TABLE_PREFIX` into `wrangler.toml` at deploy time via `sed`, so no IDs are ever committed to the repository. With the resources above and these values in place, the deploy is the whole setup for a fresh install: it creates the Worker when it does not exist yet, creates the tables, and writes the `TABLE_PREFIX` binding without any Cloudflare dashboard step (step 5).

### 4. Optional Worker variables

**No dashboard step is required.** `TABLE_PREFIX` and the three runtime secrets (`JWT_SECRET`, `SETUP_SECRET`, `TOTP_ENCRYPTION_KEY`) all come from the GitHub values in step 3 and are written to the Worker by the deploy workflow on every run. Do **not** create or edit them in [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages → Hop → Settings → Variables and Secrets**: with a prefix in use, a dashboard edit of `TABLE_PREFIX` makes the next deploy's migration guard abort until GitHub and the Worker agree again (and that deploy rewrites the binding from the GitHub variable anyway); a dashboard copy of one of the secrets is replaced by CI on the next deploy.

What you may optionally configure on the Worker itself — CI never touches these, and `keep_vars = true` in `wrangler.toml` keeps them across deployments:

| Name | Type | Required | Example / Notes |
|---|---|---|---|
| `APP_URL` | Variable | No | Canonical base URL (e.g. `https://yourdomain.com`). Optional — defaults to the origin of each request. Set it only to pin a URL that differs from the one clients hit. |
| `RP_ID` | Variable | No | WebAuthn relying party ID (domain only). Optional — defaults to the request hostname. |
| `APP_ORIGIN` | Variable | No | WebAuthn origin (full URL). Optional — defaults to the origin of each request. |

> `TABLE_PREFIX` is intentionally **not** in the table above: it is configuration-managed by the deploy (step 3). Unset → default `hop` (`hop_users`, `hop_links`, …). A custom value → that value, case preserved, `[^a-zA-Z0-9_]` stripped. `none` in GitHub → explicit empty string, no prefix (deployer accepts the table-collision risk). Set it before the first deploy and never change it once data exists.
>
> `APP_URL` / `RP_ID` / `APP_ORIGIN` are optional: when unset the Worker derives them from the incoming request (see [Environment Variables](#environment-variables)). An explicit value always wins, so a deployment that already configures them behaves exactly as before. `APP_NAME` is **no longer an env var** — the app name is the admin UI setting `app_name` (default `Hop`).
>
> `RP_ID` / `APP_ORIGIN` are the WebAuthn passkey relying-party identifiers. If you configure them, their values must **never change** — changing them invalidates every user's passkeys. With them unset, the rpID is derived from the hostname the user actually visits, so credentials stay bound to that hostname: visiting through your custom domain behaves like the old explicit config, while visiting through another hostname (e.g. `*.workers.dev`) yields a different rpID and therefore different passkey scope — inherent to a multi-hostname deployment, not a regression.
>
> Upgrading from a Worker whose `TOTP_ENCRYPTION_KEY` was created in the dashboard: put that same value into the GitHub Secret `TOTP_ENCRYPTION_KEY` (step 3) first — a different value makes every bound TOTP unreadable — then delete the dashboard copy.
>
> Email provider settings (Resend API key, SMTP credentials, etc.) are configured in the **admin UI** after first login — no Cloudflare dashboard config needed.

### 5. Build and deploy

Go to **GitHub Actions → Deploy** and click **Run workflow** to trigger the deployment manually (a push or merge to `main` also deploys automatically once CI passes).

One click is enough for a brand-new install, with the default prefix and a custom one alike:

- wrangler uploads the code and creates the Worker if it does not exist yet;
- the migrations run before the upload and create the tables under the resolved prefix;
- the uploaded version carries the `TABLE_PREFIX` binding that CI wrote from the GitHub variable;
- the workflow then confirms through the Cloudflare API that this version serves 100% of production traffic with the same prefix, and the smoke test probes the deployed URL.

Two follow-ups stay manual, and neither of them affects whether the deploy succeeds:

- **Custom domain** — bind it whenever you want one (Workers & Pages → Hop → Settings → Domains & Routes). Until then the deployment is reachable on its workers.dev address, which the smoke test probes automatically while `APP_URL` is unset.
- **`APP_URL`** — once the domain is bound, optionally set the GitHub variable (step 3) so the smoke test probes the real production entry point.

### 6. Run database migrations

The Deploy workflow applies migrations automatically **before** deploying the code.
Without a prefix it uses `wrangler d1 migrations apply` as before. With `TABLE_PREFIX`
set it applies the migrations from `apps/worker/src/lib/migrations.ts` (the same ones
the setup route runs), skips those already recorded in `_<prefix>_schema_migrations`,
and prints the planned migrations in the log. Migrations must stay backward compatible:
only add tables, indexes or columns — never drop, rename or rewrite existing data.

GitHub Actions cannot distinguish an unset `vars.TABLE_PREFIX` from an empty one, so
the deploy workflow resolves it to the three runtime states: **unset or empty → `hop`**
(the default), **`none` → explicit empty string** (no prefix), **anything else → as-is**.

> **Upgrade warning** — a legacy deployment that never set a prefix used unprefixed
> tables. If the resolved prefix differs from the prefix the database was initialised
> under, setup and migrations **abort with an error** instead of silently switching to
> a different (usually empty) set of tables. Configure `TABLE_PREFIX` to its previous
> value (`TABLE_PREFIX=''`, or `TABLE_PREFIX=none` in CI, to keep unprefixed tables)
> before upgrading. Installations created before the `sl` → `hop` default change that
> relied on the bare default (`sl_users`, …) must set `TABLE_PREFIX=sl` explicitly.

Use a custom prefix by setting `TABLE_PREFIX` under the GitHub **production environment →
Variables** (e.g. `SL`; letters, digits and underscores only) — that variable is the only
place it is configured. The deploy writes it into the Worker's `TABLE_PREFIX` **plain-text
binding**, so do not add or edit that binding in the Cloudflare dashboard, never store the
value as a secret (a secret cannot be read back for comparison), and do not change it once
data exists.

With a prefix in use, the migration guard — which runs before the new code is uploaded —
compares the prefix the deployed Worker currently uses with the GitHub variable and aborts
on a mismatch: a mistyped GitHub value can never migrate another application's tables, and
a stray dashboard edit is caught before it takes effect (the next deploy would rewrite the binding from the GitHub variable anyway). If the Worker
is gone but its `<prefix>_` tables and `_<prefix>_schema_migrations` ledger still exist, the
ledger proves those tables are this app's, so the run continues and the deploy recreates
the Worker; prefixed tables **without** that ledger still abort.

`APP_URL` is optional — when it is set the smoke test probes it, otherwise the test
resolves the Workers' own workers.dev address. `CLOUDFLARE_API_TOKEN` needs edit access to
the D1 database, edit/version-read access to the Worker, and Workers Scripts:Read for that
workers.dev lookup.

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

## Optional: also schedule with waker (dual run)

Hop's nightly cleanup (expired `verifications` rows, plus `totp_used` rows older than 90 s) runs
on the Cloudflare Cron Trigger `0 3 * * *` declared in `apps/worker/wrangler.toml`. A deployment
can also let [waker](https://github.com/WorkerHub/waker) deliver the same job over HTTP: the
platform POSTs `/_waker/execute`, which runs the **same** cleanup function as `scheduled()`.

There is nothing to switch on: one input decides everything — the signing key.

| `WAKER_SIGNING_KEY` | `/_waker/execute` | Native Cron Trigger | State |
|---|---|---|---|
| Secret absent (or empty) | 500 `signing_key_missing` (JSON) | `0 3 * * *` | fail closed — nothing unverified ever runs |
| Secret present | signature verified, then the cleanup runs | `0 3 * * *` | dual run; the cleanup is idempotent |

`[triggers]` is static: it lives in `apps/worker/wrangler.toml` and the pipeline never rewrites it,
so the native trigger is deployed in both states. There is no mode variable, platform URL or
schedule switch to configure — the deployment variables from the earlier dual-mode design are gone;
if your repository still has them, they are ignored and can be deleted. Any path under `/_waker`
that is not routed answers JSON (404 or the SDK's stable error code) — never the SPA's 200 HTML,
which waker would read as a successful run.

### The only input: `WAKER_SIGNING_KEY`

| Secret | Required | Source | Description |
|---|---|---|---|
| `WAKER_SIGNING_KEY` | No | GitHub Secret → CI | The hop project's callback signing key, shown **once** when the project is created in the waker UI. When the Secret exists the deploy injects it through `--secrets-file`; when it does not, the deploy still succeeds and the callback answers 500 `signing_key_missing` instead of running an unverified job. Never logged, never committed. |

### Create the waker job (once, in the waker UI)

Create the `hop` project with its callback URL pointing at this Worker, then add this declarative
job — these values are frozen, copy them verbatim (the job name must match the receiver's key):

| Field | Value |
|---|---|
| Job name | `nightly-cleanup` |
| Kind / cron | `cron` / `0 3 * * *` |
| Timezone | `UTC` |
| `concurrency` | `forbid` |
| `misfirePolicy` | `skip` |
| `maxRetries` / `backoffSeconds` | `2` / `60` |
| `timeoutSeconds` / `jitterSeconds` | `30` / `0` |

### Dual run, switching to waker alone, and rolling back

1. Create the `hop` project in waker (callback URL = this Worker's public base URL) and store the
   signing key it shows once as the GitHub Secret `WAKER_SIGNING_KEY` (same path as the other
   runtime secrets — never in the repository). Deploy: the receiver is live next to the Cron
   Trigger — the dual-run state, harmless because the cleanup is idempotent.
2. Create and enable the `nightly-cleanup` job in waker, then watch one full daily cycle:
   waker's executions list shows a success, and the Worker log has
   `"event":"nightly_cleanup","source":"waker"` with the delete counts and duration.
3. Switch over in a separate, small change: delete the `[triggers]` section from
   `apps/worker/wrangler.toml` and merge it on its own. waker is then the only scheduler; nothing
   else has to change.

Rollback: revert that commit (the `[triggers]` section comes back) and redeploy — the Cron Trigger
is back, and waker can keep delivering in parallel or be paused in its UI. No database rollback is
needed: `schema_v3` only adds `{prefix}waker_executions`, which nothing else reads.

To close the callback instead, delete the Worker's `WAKER_SIGNING_KEY` secret in the dashboard (the
deploy only ever adds secrets, it never removes one): `/_waker/execute` then answers 500
`signing_key_missing`. Leaving the key bound is harmless as long as the waker job is paused.

Cleanup results are logged as structured JSON (`nightly_cleanup` with counts, duration and the
trigger source; rejected callbacks as `waker_callback_rejected` with the HTTP status and the
SDK's error code, e.g. `invalid_signature`, `stale_timestamp`, `unknown_job`). Signing keys are
never logged.

---

## Local Development

```bash
# 1. Create apps/worker/.dev.vars
cat > apps/worker/.dev.vars << 'EOF'
# APP_URL / RP_ID / APP_ORIGIN are optional — unset, they are derived from the
# request URL (http://localhost:8787 → rpID "localhost"). APP_ORIGIN is only
# needed for passkey testing, where the page runs on the Vite dev server
# (:5173) while /api is proxied to the Worker (:8787).
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

`TABLE_PREFIX` and the three secrets come from this repository's GitHub Secrets/Variables (step 3) and are written to the Worker by the deploy workflow — do not configure them in the Cloudflare dashboard. The optional `APP_URL` / `RP_ID` / `APP_ORIGIN` variables are the only ones set on the Worker itself (Workers & Pages → Hop → Settings → Variables and Secrets), and `keep_vars = true` in `wrangler.toml` keeps them across deployments.

| Variable | Type | Required | Source | Description |
|---|---|---|---|---|
| `APP_URL` | Var | No | Worker (dashboard) | Canonical base URL (e.g. `https://go.example.com`). Optional — defaults to the request origin (used for CORS, HSTS, the refresh cookie's `Secure` flag and the `/404` redirect). |
| `RP_ID` | Var | No | Worker (dashboard) | WebAuthn relying party ID (domain without protocol). Optional — defaults to the request hostname. |
| `APP_ORIGIN` | Var | No | Worker (dashboard) | WebAuthn origin (full URL). Optional — defaults to the request origin. |
| `TABLE_PREFIX` | Var | No | GitHub `TABLE_PREFIX` → CI | Three-state prefix for all D1 table names. Unset → default `hop` (`hop_users`, `hop_links`, …); custom value → that value (case preserved); `none` in GitHub → explicit empty, no prefix. Set once before the first deploy — changing it later requires renaming tables. Only alphanumeric and underscore characters are used. |
| `JWT_SECRET` | Secret | Yes | GitHub Secret → CI | HS256 signing key, ≥ 32 chars |
| `TOTP_ENCRYPTION_KEY` | Secret | Yes | GitHub Secret → CI | Hex string from `openssl rand -hex 32` |
| `SETUP_SECRET` | Secret | Yes | GitHub Secret → CI | Secret path for triggering DB migrations via HTTP |
| `WAKER_SIGNING_KEY` | Secret | No | GitHub Secret → CI | The hop project's callback signing key, shown once when the project is created in waker. Present → the deploy injects it and `/_waker/execute` verifies and runs the cleanup; absent → the deploy still succeeds and the callback answers 500 `signing_key_missing`. See [Optional: also schedule with waker](#optional-also-schedule-with-waker-dual-run). Never logged or committed. |

---

## Settings (Admin Panel)

| Key | Values | Description |
|---|---|---|
| `registration_enabled` | `true` / `false` | Allow new user registration (default: `false`) |
| `require_email_verification` | `true` / `false` | Require new users to verify their email before signing in (default: `false`) |
| `app_name` | string | App name shown in the UI, emails and passkey prompts. Default `Hop`. There is no env var for it — this setting is the single source. |
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
