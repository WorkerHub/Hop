// Single resolution entry point for the four deployment-dependent app settings
// that used to be mandatory Worker variables (APP_URL / RP_ID / APP_ORIGIN /
// APP_NAME). Every route must come through here — no route may derive these on
// its own. Rule, uniformly: an explicitly configured variable always wins;
// otherwise the value is derived from the incoming request (or, for the app
// name, from the persisted setting).
//
// Grep guard: `env.APP_URL` / `env.RP_ID` / `env.APP_ORIGIN` / `env.APP_NAME`
// must only appear in this file.

import type { Context } from 'hono';
import type { Env, Variables } from '../types.js';
import { tbl } from './db.js';
import { getCachedSetting, setCachedSetting } from './kv.js';

// Fallback app name when the settings table has no app_name row. APP_NAME is no
// longer an env var: the admin UI setting is the single source of truth.
export const DEFAULT_APP_NAME = 'Hop';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// A variable holding nothing but whitespace counts as "not configured", exactly
// like an unset one — "  " is never a usable origin or RP ID. A configured value
// is otherwise returned verbatim (not trimmed): call sites keep their existing
// normalization, so a padded-but-valid value behaves byte-for-byte as before.
function configured(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

// Canonical base URL of this deployment (scheme + host, no trailing slash).
// Used for CORS allow-listing, HSTS gating, the refresh-cookie Secure flag and
// the /404 redirect target.
export function appUrl(c: AppContext): string {
  return configured(c.env.APP_URL) ?? new URL(c.req.url).origin;
}

// WebAuthn relying-party ID — a bare hostname.
export function rpId(c: AppContext): string {
  return configured(c.env.RP_ID) ?? new URL(c.req.url).hostname;
}

// WebAuthn origin — scheme + host.
export function appOrigin(c: AppContext): string {
  return configured(c.env.APP_ORIGIN) ?? new URL(c.req.url).origin;
}

// App name from the admin UI setting (DB, fronted by the KV cache). The row is
// cached for 60s — including the default — and PUT /api/admin/settings drops
// the cache key on write, so an admin rename is visible immediately.
export async function appName(
  env: Pick<Env, 'DB' | 'LINKS_KV' | 'TABLE_PREFIX'>,
): Promise<string> {
  const cached = await getCachedSetting(env.LINKS_KV, 'app_name');
  if (cached !== null) return cached;
  const row = await env.DB.prepare(
    `SELECT value FROM ${tbl(env, 'settings')} WHERE key = 'app_name'`,
  ).first<{ value: string }>();
  const value = row?.value ?? DEFAULT_APP_NAME;
  await setCachedSetting(env.LINKS_KV, 'app_name', value);
  return value;
}
