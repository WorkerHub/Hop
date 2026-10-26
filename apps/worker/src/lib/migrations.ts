// Schema migrations, parameterised by TABLE_PREFIX. Single source of truth for
// both the HTTP setup route (routes/setup.ts) and the deploy workflow
// (.github/scripts/d1-migrations.mjs loads this file with Node's built-in
// TypeScript type stripping) — so keep it free of imports other than the
// type-strippable table-prefix.ts, and of TS-only runtime syntax (enums,
// namespaces, parameter properties).
//
// Migrations must stay additive (CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE
// ADD COLUMN, INSERT OR IGNORE): the deploy workflow runs them before the new
// code goes live, and its guard rejects anything else.

// ─── Table-prefix helper (single source: src/lib/table-prefix.ts) ────────────

import { DEFAULT_TABLE_PREFIX, tbl } from './table-prefix.ts';

export { DEFAULT_TABLE_PREFIX, tbl };

// Name of the table recording applied migrations, e.g. `_SL_schema_migrations`.
export function migrationsTable(prefix: string): string {
  return `_${tbl(prefix, 'schema_migrations')}`;
}

export function createMigrationsTableSql(prefix: string): string {
  return `CREATE TABLE IF NOT EXISTS ${migrationsTable(prefix)} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`;
}

// ─── Migration factory ────────────────────────────────────────────────────────
// Returns migrations parameterised by the table prefix so setup works whether
// TABLE_PREFIX is empty or set to a custom value.

export interface Migration {
  name: string;
  // wrangler migration file this corresponds to (migrations/<fileName>).
  // The numeric prefix maps to the migration name via the schema_vN convention.
  fileName: string;
  sql: string;
}

export function getMigrations(p: string): Migration[] {
  const t = (name: string) => tbl(p, name);
  return [
    {
      name: 'schema_v1',
      fileName: '0001_init.sql',
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
  ('app_name',                   'Hop'),
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
      fileName: '0002_token_version.sql',
      sql: `
ALTER TABLE ${t('users')} ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
`,
    },
  ];
}

// ─── Wrangler migration files owned by this app ───────────────────────────────
// The `name` values Wrangler records in its `d1_migrations` ledger when it
// applies this app's migrations (migrations/*.sql) without a table prefix.
//
// The silent-switch guard (src/lib/migrations-runner.ts) compares the ledger's
// contents against this set instead of only checking that the table exists:
// `d1_migrations` is a database-wide singleton, so any other app on the shared
// D1 database that ever ran `wrangler d1 migrations apply` leaves it behind,
// recording *that* app's file names — never a sign of an unprefixed schema here.
//
// Derived from each migration's `fileName`, the same single source of truth that
// generates migrations/*.sql (scripts/generate-migrations.ts): adding a Wrangler
// migration means adding a migration here, so there is no second list to keep
// in sync. test/migrations-runner.test.ts asserts this set equals the files
// actually present in migrations/, so a hand-edited directory fails CI.
export const WRANGLER_MIGRATION_FILES: readonly string[] = getMigrations(
  '',
).map((m) => m.fileName);
