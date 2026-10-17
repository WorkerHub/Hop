-- DO NOT EDIT. Generated from src/lib/migrations.ts (getMigrations("")).
-- Regenerate with: pnpm --filter @shortlink/worker generate:migrations

CREATE TABLE users (
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
CREATE TABLE passkeys (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    TEXT    NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  name          TEXT,
  aaguid        TEXT,
  transports    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER
);
CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);
CREATE TABLE links (
  id              TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug            TEXT    UNIQUE NOT NULL,
  destination_url TEXT    NOT NULL,
  title           TEXT,
  expires_at      INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  user_seq        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_links_slug       ON links(slug);
CREATE INDEX idx_links_user_id    ON links(user_id);
CREATE INDEX idx_links_expires_at ON links(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE click_logs (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  link_id     TEXT    NOT NULL REFERENCES links(id) ON DELETE CASCADE,
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
CREATE INDEX idx_click_logs_link_id    ON click_logs(link_id);
CREATE INDEX idx_click_logs_created_at ON click_logs(created_at);
CREATE INDEX idx_click_logs_link_time  ON click_logs(link_id, created_at);
CREATE TABLE verifications (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  identifier  TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN ('email_otp', 'password_reset', 'email_verify')),
  code_hash   TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_verifications_identifier ON verifications(identifier, type);
CREATE TABLE settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO settings (key, value) VALUES
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
CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  admin_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  details    TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_audit_logs_admin_id   ON audit_logs(admin_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_target_id  ON audit_logs(target_id);
CREATE TABLE totp_used (
  user_id TEXT NOT NULL,
  code    TEXT NOT NULL,
  used_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, code)
);
CREATE INDEX idx_totp_used_at ON totp_used(used_at);
