import type {
  D1Database,
  Fetcher,
  KVNamespace,
} from '@cloudflare/workers-types';

export interface Env {
  // Bindings
  DB: D1Database;
  LINKS_KV: KVNamespace;
  ASSETS: Fetcher;

  // Vars
  // ONE-437: all three are optional — when unset they are derived from the
  // request (see lib/app-defaults.ts). APP_NAME is deliberately gone from Env:
  // the app name lives only in the admin UI setting (settings.app_name).
  APP_URL?: string;
  RP_ID?: string;
  APP_ORIGIN?: string;
  TABLE_PREFIX?: string;

  // Secrets
  JWT_SECRET: string;
  TOTP_ENCRYPTION_KEY: string;
  SETUP_SECRET: string;
  // Waker project signing key (callback HMAC verification) — and the callback's
  // only switch: bound → /_waker/execute verifies then runs the same cleanup as
  // scheduled(); absent → it fails closed with 500 `signing_key_missing`.
  // Secrets only: GitHub Secret → `wrangler deploy --secrets-file`.
  WAKER_SIGNING_KEY?: string;
}

export interface Variables {
  userId: string;
  userRole: 'admin' | 'user';
  userEmail: string;
  userJti: string;
  userTokenExp: number; // S1: used to compute exact denylist TTL from token expiry
  requestId: string; // BE-Q3: set per request for structured error logging
}

// ─── DB row types ────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  totp_secret: string | null;
  totp_enabled: number;
  totp_backup_codes: string | null;
  email_2fa_enabled: number;
  passkey_enabled: number;
  is_active: number;
  token_version: number;
  created_at: number;
  updated_at: number;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  name: string | null;
  aaguid: string | null;
  transports: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface LinkRow {
  id: string;
  user_id: string;
  slug: string;
  destination_url: string;
  title: string | null;
  expires_at: number | null;
  is_active: number;
  user_seq: number;
  created_at: number;
  updated_at: number;
}

export interface ClickLogRow {
  id: string;
  link_id: string;
  ip_address: string | null;
  user_agent: string | null;
  referer: string | null;
  country: string | null;
  city: string | null;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  created_at: number;
}

export interface VerificationRow {
  id: string;
  identifier: string;
  type: 'email_otp' | 'password_reset' | 'email_verify';
  code_hash: string;
  expires_at: number;
  attempts: number;
  used: number;
  created_at: number;
}

// ─── KV cache types ───────────────────────────────────────────────────────────

export interface CachedLink {
  url: string;
  linkId: string;
  isActive: number;
  expiresAt: number | null;
}

// ─── JWT payload types ────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  sub: string;
  role: 'admin' | 'user';
  email: string;
  tv: number;
  purpose: 'access';
  jti: string;
  exp: number;
}

export interface RefreshTokenPayload {
  sub: string;
  tv: number;
  purpose: 'refresh';
  jti: string;
  exp: number;
}

export interface PendingTokenPayload {
  sub: string;
  purpose: '2fa_pending';
  jti: string;
  methods: string[];
  exp: number; // S-1: available for denylist TTL computation
}
