// BE-Q2: auth critical-path tests — login, refresh (rotation + token_version
// revocation) and change-password revocation. Uses the real routes, real JWT
// signing/verification, and an in-memory SQLite D1 with the real migrations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import auth from '../src/routes/auth.ts';
import {
  accessTokenFor,
  makeEnv,
  refreshTokenFor,
  request,
  seedUser,
} from './helpers/app.ts';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('login: 正确凭据签发 access token 并设置 HttpOnly refresh cookie', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'correct-password',
  });

  const res = await request(
    auth,
    '/login',
    json({ email: 'alice@example.com', password: 'correct-password' }),
    ctx,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.accessToken, 'expected an access token');
  assert.equal(body.user.email, 'alice@example.com');
  const cookie = res.headers.get('Set-Cookie') ?? '';
  assert.match(cookie, /refreshToken=[^;]+/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
});

test('login: 密码错误返回 401', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'correct-password',
  });

  const res = await request(
    auth,
    '/login',
    json({ email: 'alice@example.com', password: 'wrong-password' }),
    ctx,
  );
  assert.equal(res.status, 401);
});

test('login: 连续失败触发限流返回 429', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'correct-password',
  });

  for (let i = 0; i < 10; i++) {
    const res = await request(
      auth,
      '/login',
      json({ email: 'alice@example.com', password: 'wrong-password' }),
      ctx,
    );
    assert.equal(res.status, 401, `attempt ${i + 1} should be a 401`);
  }
  const blocked = await request(
    auth,
    '/login',
    json({ email: 'alice@example.com', password: 'correct-password' }),
    ctx,
  );
  assert.equal(blocked.status, 429);
});

test('refresh: 有效 refresh token 轮换出新 access token', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'correct-password',
  });
  const rt = await refreshTokenFor('u1', 0);

  const res = await request(
    auth,
    '/refresh',
    { method: 'POST', headers: { Cookie: `refreshToken=${rt}` } },
    ctx,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.accessToken, 'expected a fresh access token');
});

test('refresh: token_version 不匹配则吊销（401）', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 1,
    password: 'correct-password',
  });
  // Signed for the previous token_version (0), but the account is now at 1.
  const rt = await refreshTokenFor('u1', 0);

  const res = await request(
    auth,
    '/refresh',
    { method: 'POST', headers: { Cookie: `refreshToken=${rt}` } },
    ctx,
  );
  assert.equal(res.status, 401);
});

test('change-password 自增 token_version，旧 refresh token 随之失效', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'old-password',
  });
  const access = await accessTokenFor({
    id: 'u1',
    email: 'alice@example.com',
    role: 'user',
    tokenVersion: 0,
  });
  const rt = await refreshTokenFor('u1', 0);

  const change = await request(
    auth,
    '/change-password',
    json(
      { currentPassword: 'old-password', newPassword: 'new-password-1' },
      { Authorization: `Bearer ${access}` },
    ),
    ctx,
  );
  assert.equal(change.status, 200);

  const row = ctx.db
    .prepare('SELECT token_version FROM users WHERE id = ?1')
    .bind('u1')
    .first<{ token_version: number }>();
  assert.equal(row?.token_version, 1);

  const refresh = await request(
    auth,
    '/refresh',
    { method: 'POST', headers: { Cookie: `refreshToken=${rt}` } },
    ctx,
  );
  assert.equal(refresh.status, 401);
});

test('forgot-password: 已注册与未注册邮箱都立即返回 success（BE-S9）', async (t) => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'correct-password',
  });

  // Configure Resend + a fake upstream so the async send actually stores a code.
  ctx.db
    .prepare("UPDATE settings SET value = ?1 WHERE key = 'resend_api_key'")
    .bind('test-key')
    .run();
  ctx.db
    .prepare("UPDATE settings SET value = ?1 WHERE key = 'email_from_domain'")
    .bind('example.com')
    .run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"id":"ok"}', { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const found = await request(
    auth,
    '/forgot-password',
    json({ email: 'alice@example.com' }),
    ctx,
  );
  assert.equal(found.status, 200);
  await Promise.all(ctx.waitUntil);
  const stored = ctx.db
    .prepare(
      "SELECT COUNT(*) AS n FROM verifications WHERE identifier = ?1 AND type = 'password_reset' AND used = 0",
    )
    .bind('alice@example.com')
    .first<{ n: number }>();
  assert.equal(stored?.n, 1);

  const missing = await request(
    auth,
    '/forgot-password',
    json({ email: 'nobody@example.com' }),
    ctx,
  );
  assert.equal(missing.status, 200);
});

test('2fa/totp/setup: 只接受 POST（BE-S12）', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'correct-password',
  });
  const access = await accessTokenFor({
    id: 'u1',
    email: 'alice@example.com',
    role: 'user',
    tokenVersion: 0,
  });

  const get = await request(
    auth,
    '/2fa/totp/setup',
    { method: 'GET', headers: { Authorization: `Bearer ${access}` } },
    ctx,
  );
  // Hono returns 404 (not 200) for a path that has no GET handler — the old
  // GET-based endpoint is gone.
  assert.equal(get.status, 404);

  const post = await request(
    auth,
    '/2fa/totp/setup',
    { method: 'POST', headers: { Authorization: `Bearer ${access}` } },
    ctx,
  );
  assert.equal(post.status, 200);
  const body = await post.json();
  assert.ok(body.secret);
  assert.match(body.uri, /^otpauth:\/\//);
});
