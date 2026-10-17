import { Hono } from 'hono';
import { constantTimeEqual } from '../lib/crypto.js';
import { checkSetupRateLimit } from '../lib/kv.js';
import type { Env, Variables } from '../types.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Table-prefix helper (mirrors src/lib/db.ts) ──────────────────────────────

function tbl(prefix: string, name: string): string {
  const p = prefix.replace(/[^a-zA-Z0-9_]/g, '');
  return p ? `${p}_${name}` : name;
}

// ─── Migration factory ────────────────────────────────────────────────────────
// Returns migrations parameterised by the table prefix so setup works whether
// TABLE_PREFIX is empty or set to a custom value.

function getMigrations(p: string): { name: string; sql: string }[] {
  const t = (name: string) => tbl(p, name);
  return [
    {
      name: 'schema_v1',
      sql: `
CREATE TABLE IF NOT EXISTS ${t('users')} (
  id            TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email         TEXT    UNIQUE NOT NULL,
  username      TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  totp_backup_codes TEXT,
  email_2fa_enabled INTEGER NOT NULL DEFAULT 0,
  passkey_enabled   INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS ${t('passkeys')} (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES ${t('users')}(id) ON DELETE CASCADE,
  public_key    TEXT    NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  name          TEXT,
  aaguid        TEXT,
  transports    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON ${t('passkeys')}(user_id);
CREATE TABLE IF NOT EXISTS ${t('links')} (
  id              TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id         TEXT    NOT NULL REFERENCES ${t('users')}(id) ON DELETE CASCADE,
  slug            TEXT    UNIQUE NOT NULL,
  destination_url TEXT    NOT NULL,
  title           TEXT,
  expires_at      INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  user_seq        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_links_slug       ON ${t('links')}(slug);
CREATE INDEX IF NOT EXISTS idx_links_user_id    ON ${t('links')}(user_id);
CREATE INDEX IF NOT EXISTS idx_links_expires_at ON ${t('links')}(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${t('click_logs')} (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  link_id     TEXT    NOT NULL REFERENCES ${t('links')}(id) ON DELETE CASCADE,
  ip_address  TEXT,
  user_agent  TEXT,
  referer     TEXT,
  country     TEXT,
  city        TEXT,
  device_type TEXT,
  browser     TEXT,
  os          TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_click_logs_link_id    ON ${t('click_logs')}(link_id);
CREATE INDEX IF NOT EXISTS idx_click_logs_created_at ON ${t('click_logs')}(created_at);
CREATE INDEX IF NOT EXISTS idx_click_logs_link_time  ON ${t('click_logs')}(link_id, created_at);
CREATE TABLE IF NOT EXISTS ${t('verifications')} (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  identifier  TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN ('email_otp', 'password_reset', 'email_verify')),
  code_hash   TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON ${t('verifications')}(identifier, type);
CREATE TABLE IF NOT EXISTS ${t('settings')} (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO ${t('settings')} (key, value) VALUES
  ('registration_enabled',       'true'),
  ('require_email_verification', 'false'),
  ('app_name',                   'ShortLink'),
  ('email_provider',       'resend'),
  ('smtp_host',            ''),
  ('smtp_port',            '587'),
  ('smtp_user',            ''),
  ('smtp_pass',            ''),
  ('smtp_from',            ''),
  ('resend_api_key',       ''),
  ('email_from_domain',    ''),
  ('email_from_name',      '');
CREATE TABLE IF NOT EXISTS ${t('audit_logs')} (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  admin_id   TEXT REFERENCES ${t('users')}(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  details    TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id   ON ${t('audit_logs')}(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON ${t('audit_logs')}(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_id  ON ${t('audit_logs')}(target_id);
CREATE TABLE IF NOT EXISTS ${t('totp_used')} (
  user_id TEXT NOT NULL,
  code    TEXT NOT NULL,
  used_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, code)
);
CREATE INDEX IF NOT EXISTS idx_totp_used_at ON ${t('totp_used')}(used_at);
`,
    },
    {
      // BE-S3/S4: per-user token_version — bumping it revokes all of a user's
      // sessions (password change/reset, admin disable/demote).
      name: 'schema_v2',
      sql: `
ALTER TABLE ${t('users')} ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
`,
    },
  ];
}

// D1's exec() only processes the first line of a multi-line string.
// Strip SQL line comments and collapse all whitespace to a single line.
function toSingleLine(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// BE-S5: POST + header secret (kept out of URL/logs), constant-time comparison,
// and per-IP rate limiting. When SETUP_SECRET is not set the endpoint 404s.
app.post('/', async (c) => {
  if (!c.env.SETUP_SECRET) {
    return c.notFound();
  }

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const allowed = await checkSetupRateLimit(c.env.LINKS_KV, ip);
  if (!allowed) {
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  }

  const provided = c.req.header('X-Setup-Secret') ?? '';
  if (!constantTimeEqual(provided, c.env.SETUP_SECRET)) {
    return c.notFound();
  }

  const prefix = c.env.TABLE_PREFIX ?? '';
  const migrationsTable = `_${tbl(prefix, 'schema_migrations')}`;

  // Use prepare().run() for single-statement DDL — avoids exec()'s newline limitation
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${migrationsTable} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
  ).run();

  const { results } = await c.env.DB.prepare(
    `SELECT name FROM ${migrationsTable}`,
  ).all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));

  const log: {
    name: string;
    status: 'applied' | 'skipped' | 'error';
    error?: string;
  }[] = [];

  for (const migration of getMigrations(prefix)) {
    if (applied.has(migration.name)) {
      log.push({ name: migration.name, status: 'skipped' });
      continue;
    }
    try {
      await c.env.DB.exec(toSingleLine(migration.sql));
      await c.env.DB.prepare(`INSERT INTO ${migrationsTable} (name) VALUES (?)`)
        .bind(migration.name)
        .run();
      log.push({ name: migration.name, status: 'applied' });
    } catch (err) {
      log.push({ name: migration.name, status: 'error', error: String(err) });
      break;
    }
  }

  return c.json({ migrations: log });
});

export default app;
