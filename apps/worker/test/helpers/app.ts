// Shared harness for the worker route tests: builds an Env with an in-memory
// D1 + KV, seeds users, and signs real JWTs so the auth middleware is exercised
// end-to-end (rather than stubbed out).
import type { Hono } from 'hono';
import { hashPassword } from '../../src/lib/crypto.ts';
import { signAccessToken, signRefreshToken } from '../../src/lib/jwt.ts';
import type { Env } from '../../src/types.ts';
import { D1Mock, MemoryKV } from './env.ts';

export const TEST_SECRET =
  'test-secret-0123456789abcdef0123456789abcdef0123456789';
export const APP_URL = 'https://example.com';

export interface SeedUser {
  id: string;
  email: string;
  username: string;
  role: 'admin' | 'user';
  isActive: number;
  tokenVersion: number;
  password: string;
}

export interface TestEnv {
  env: Env;
  db: D1Mock;
  kv: MemoryKV;
  // Background tasks scheduled via ctx.waitUntil (e.g. forgot-password email,
  // click logging) — captured so a test can await them.
  waitUntil: Promise<unknown>[];
}

export function makeEnv(overrides: Partial<Env> = {}): TestEnv {
  const db = new D1Mock();
  const kv = new MemoryKV();
  const env = {
    DB: db,
    LINKS_KV: kv,
    ASSETS: { fetch: async () => new Response('assets', { status: 200 }) },
    APP_URL,
    RP_ID: 'example.com',
    APP_ORIGIN: APP_URL,
    TABLE_PREFIX: '',
    JWT_SECRET: TEST_SECRET,
    TOTP_ENCRYPTION_KEY: '0'.repeat(64),
    SETUP_SECRET: 'test-setup-secret',
    ...overrides,
  } as unknown as Env;
  return { env, db, kv, waitUntil: [] };
}

// ONE-437: APP_URL / RP_ID / APP_ORIGIN are optional env vars now — a fresh
// deployment configures none of them. This strips all three from the default env
// so a test exercises the request-derived path; pass overrides to configure a
// subset (that is how the "explicit config wins" cases are built).
export function makeEnvWithoutAppVars(overrides: Partial<Env> = {}): TestEnv {
  return makeEnv({
    APP_URL: undefined,
    RP_ID: undefined,
    APP_ORIGIN: undefined,
    ...overrides,
  });
}

export async function seedUser(
  db: D1Mock,
  user: Omit<SeedUser, 'password'> & { password: string },
): Promise<string> {
  const passwordHash = await hashPassword(user.password);
  db.prepare(
    `INSERT INTO users (id, email, username, password_hash, role, is_active, token_version)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      user.id,
      user.email,
      user.username,
      passwordHash,
      user.role,
      user.isActive,
      user.tokenVersion,
    )
    .run();
  return user.id;
}

export async function accessTokenFor(
  user: {
    id: string;
    email: string;
    role: 'admin' | 'user';
    tokenVersion: number;
  },
  secret = TEST_SECRET,
): Promise<string> {
  const { token } = await signAccessToken(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
      tv: user.tokenVersion,
    },
    secret,
  );
  return token;
}

export async function refreshTokenFor(
  userId: string,
  tv: number,
  secret = TEST_SECRET,
): Promise<string> {
  const { token } = await signRefreshToken(userId, tv, secret);
  return token;
}

export interface AppContext {
  env: Env;
  db: D1Mock;
  kv: MemoryKV;
  waitUntil: Promise<unknown>[];
}

export function request(
  app: Hono,
  path: string,
  init: RequestInit,
  ctx: AppContext,
): Promise<Response> {
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      ctx.waitUntil.push(promise);
    },
    passThroughOnException: () => {},
    props: {},
  };
  return app.request(path, init, ctx.env, executionCtx);
}
