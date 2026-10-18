// Routing-level tests against the full app (index.ts): unmatched /api/* must
// return a JSON 404 instead of the SPA, and error responses carry a stable
// `code` for frontend i18n.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from '../src/index.ts';
import { makeEnv, request, seedUser } from './helpers/app.ts';

test('未匹配的 /api/* 返回 JSON 404 而非 SPA', async () => {
  const ctx = makeEnv();
  const res = await request(app, '/api/does-not-exist', { method: 'GET' }, ctx);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = await res.json();
  assert.equal(body.error, 'Not found');
  assert.equal(body.code, 'NOT_FOUND');
});

test('已知路径但 method 不匹配的 /api/* 也返回 JSON 404', async () => {
  const ctx = makeEnv();
  // BE-S12: 2fa/totp/setup 只接受 POST，GET 必须落到 JSON 404。
  const res = await request(
    app,
    '/api/auth/2fa/totp/setup',
    { method: 'GET' },
    ctx,
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'Not found');
  assert.equal(body.code, 'NOT_FOUND');
});

test('非 /api 路径仍然回退到 SPA（ASSETS）', async () => {
  const ctx = makeEnv();
  const res = await request(app, '/login', { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'assets');
});

test('GET /api/health 仍返回 200（兜底不影响已有路由）', async () => {
  const ctx = makeEnv();
  const res = await request(app, '/api/health', { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('OPTIONS /api/* 预检仍由 CORS 处理（204 + Allow-Origin）', async () => {
  const ctx = makeEnv();
  const res = await request(
    app,
    '/api/anything',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    },
    ctx,
  );
  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get('Access-Control-Allow-Origin'),
    'https://example.com',
  );
});

test('注册已被占用的邮箱返回 409 且带 EMAIL_OR_USERNAME_TAKEN 码', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'password-1',
  });
  const res = await request(
    app,
    '/api/auth/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        username: 'bob',
        password: 'password-1',
      }),
    },
    ctx,
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'Email or username already taken');
  assert.equal(body.code, 'EMAIL_OR_USERNAME_TAKEN');
});

test('登录密码错误返回 401 且带 INVALID_CREDENTIALS 码', async () => {
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
    app,
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'wrong-password',
      }),
    },
    ctx,
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Invalid credentials');
  assert.equal(body.code, 'INVALID_CREDENTIALS');
});
