// ONE-437: APP_URL / RP_ID / APP_ORIGIN became optional — when unset they are
// derived from the incoming request — and APP_NAME is no longer an env var at
// all (the admin UI setting is the single source of truth, default "Hop").
//
// These tests cover both halves of the rule: an explicitly configured variable
// always wins (byte-for-byte the pre-change behavior), and with nothing
// configured every consumer works off the request URL.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { app } from '../src/index.ts';
import { appName, appOrigin, appUrl, rpId } from '../src/lib/app-defaults.ts';
import { HSTS } from '../src/lib/security.ts';
import admin from '../src/routes/admin.ts';
import auth from '../src/routes/auth.ts';
import redirect from '../src/routes/redirect.ts';
import type { Env, Variables } from '../src/types.ts';
import {
  APP_URL,
  accessTokenFor,
  makeEnv,
  makeEnvWithoutAppVars,
  request,
  seedUser,
  type TestEnv,
} from './helpers/app.ts';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const bearer = async (token: string) => ({
  Authorization: `Bearer ${token}`,
});

// A minimal app whose only job is to expose what the resolver saw, so the
// request-derived branch can be asserted directly (including the origin vs
// hostname distinction, which the port makes visible).
const probe = new Hono<{ Bindings: Env; Variables: Variables }>();
probe.get('/probe', (c) =>
  c.json({ appUrl: appUrl(c), rpId: rpId(c), appOrigin: appOrigin(c) }),
);

async function probeValues(ctx: TestEnv, url: string) {
  const res = await request(probe, url, { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  return res.json() as Promise<{
    appUrl: string;
    rpId: string;
    appOrigin: string;
  }>;
}

// ─── Resolvers: request-derived ──────────────────────────────────────────────

test('resolvers：四项都未配时，appUrl/appOrigin 用请求 origin、rpId 用 hostname', async () => {
  const ctx = makeEnvWithoutAppVars();
  const values = await probeValues(ctx, 'https://go.example.com:8443/probe');
  assert.equal(values.appUrl, 'https://go.example.com:8443');
  assert.equal(values.appOrigin, 'https://go.example.com:8443');
  // hostname has no port, origin does — the WebAuthn rpID must never carry one.
  assert.equal(values.rpId, 'go.example.com');
});

test('resolvers：显式配置优先于请求推导', async () => {
  const ctx = makeEnv({
    APP_URL: 'https://configured.example',
    RP_ID: 'configured.example',
    APP_ORIGIN: 'https://configured.example:9443',
  });
  const values = await probeValues(ctx, 'https://go.example.com:8443/probe');
  assert.equal(values.appUrl, 'https://configured.example');
  assert.equal(values.rpId, 'configured.example');
  assert.equal(values.appOrigin, 'https://configured.example:9443');
});

test('resolvers：仅空白字符的变量视为未配置，按请求推导', async () => {
  const ctx = makeEnv({ APP_URL: '   ', RP_ID: ' ', APP_ORIGIN: '\t' });
  const values = await probeValues(ctx, 'http://localhost:8787/probe');
  assert.equal(values.appUrl, 'http://localhost:8787');
  assert.equal(values.rpId, 'localhost');
  assert.equal(values.appOrigin, 'http://localhost:8787');
});

test('resolvers：已配置但带空格的变量原样返回（归一化仍由调用点负责）', async () => {
  const ctx = makeEnv({
    APP_URL: ' https://go.example.com ',
    RP_ID: ' example.com',
  });
  const values = await probeValues(ctx, 'https://other.example/probe');
  assert.equal(values.appUrl, ' https://go.example.com ');
  assert.equal(values.rpId, ' example.com');
});

// ─── CORS ────────────────────────────────────────────────────────────────────

test('CORS：未配 APP_URL 时回显请求自身 origin', async () => {
  const ctx = makeEnvWithoutAppVars();
  const res = await request(
    app,
    'https://go.example.com/api/config',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://go.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    },
    ctx,
  );
  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get('Access-Control-Allow-Origin'),
    'https://go.example.com',
  );
});

test('CORS：未配 APP_URL 时其他 origin 不被放行', async () => {
  const ctx = makeEnvWithoutAppVars();
  const res = await request(
    app,
    'https://go.example.com/api/config',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
      },
    },
    ctx,
  );
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('CORS：配了 APP_URL 时以 env 为准（请求 origin 不被放行）', async () => {
  const ctx = makeEnv({ APP_URL: 'https://configured.example' });
  const allowed = await request(
    app,
    'https://go.example.com/api/config',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://configured.example',
        'Access-Control-Request-Method': 'GET',
      },
    },
    ctx,
  );
  assert.equal(
    allowed.headers.get('Access-Control-Allow-Origin'),
    'https://configured.example',
  );

  const denied = await request(
    app,
    'https://go.example.com/api/config',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://go.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    },
    ctx,
  );
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});

// ─── Security headers (HSTS gating) ──────────────────────────────────────────

test('安全头：未配 APP_URL 时 https 请求带 HSTS、http 请求不带', async () => {
  const ctx = makeEnvWithoutAppVars();

  const https = await request(
    app,
    'https://go.example.com/api/health',
    { method: 'GET' },
    ctx,
  );
  assert.equal(https.headers.get('Strict-Transport-Security'), HSTS);

  const http = await request(
    app,
    'http://localhost:8787/api/health',
    { method: 'GET' },
    ctx,
  );
  assert.equal(http.headers.get('Strict-Transport-Security'), null);
});

test('安全头：未配 APP_URL 时 SPA HTML 响应按请求 scheme 决定 HSTS', async () => {
  const htmlCtx = () =>
    makeEnvWithoutAppVars({
      ASSETS: {
        fetch: async () =>
          new Response('<!doctype html><html><body></body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      },
    });

  const https = await request(
    app,
    'https://go.example.com/login',
    { method: 'GET' },
    htmlCtx(),
  );
  assert.equal(https.headers.get('Strict-Transport-Security'), HSTS);

  const http = await request(
    app,
    'http://localhost:5173/login',
    { method: 'GET' },
    htmlCtx(),
  );
  assert.equal(http.headers.get('Strict-Transport-Security'), null);
});

test('安全头：配了 http APP_URL 时即便请求是 https 也不发 HSTS（env 胜出）', async () => {
  const ctx = makeEnv({ APP_URL: 'http://internal.example' });
  const res = await request(
    app,
    'https://go.example.com/api/health',
    { method: 'GET' },
    ctx,
  );
  assert.equal(res.headers.get('Strict-Transport-Security'), null);
});

// ─── /404 redirect target ────────────────────────────────────────────────────

test('404 跳转：未配 APP_URL 时用请求 origin 拼 /404', async () => {
  const ctx = makeEnvWithoutAppVars();
  const res = await request(
    redirect,
    'https://go.example.com/missing',
    { method: 'GET' },
    ctx,
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://go.example.com/404');
  assert.equal(res.headers.get('Strict-Transport-Security'), HSTS);
});

test('404 跳转：配了 APP_URL 时仍用 env 值', async () => {
  const ctx = makeEnv({ APP_URL: 'https://configured.example' });
  const res = await request(
    redirect,
    'https://go.example.com/missing',
    { method: 'GET' },
    ctx,
  );
  assert.equal(res.headers.get('Location'), 'https://configured.example/404');
});

// ─── Refresh cookie Secure flag ──────────────────────────────────────────────

async function loginOver(ctx: TestEnv, url: string) {
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
    url,
    json({ email: 'alice@example.com', password: 'correct-password' }),
    ctx,
  );
  assert.equal(res.status, 200);
  return res.headers.get('Set-Cookie') ?? '';
}

test('Cookie Secure：未配 APP_URL 时 https 请求的 refresh cookie 带 Secure', async () => {
  const cookie = await loginOver(
    makeEnvWithoutAppVars(),
    'https://go.example.com/login',
  );
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

test('Cookie Secure：未配 APP_URL 时 http 请求的 refresh cookie 不带 Secure', async () => {
  const cookie = await loginOver(
    makeEnvWithoutAppVars(),
    'http://localhost:8787/login',
  );
  assert.match(cookie, /HttpOnly/);
  assert.doesNotMatch(cookie, /Secure/);
});

test('Cookie Secure：配了 https APP_URL 时 http 请求仍带 Secure（env 胜出）', async () => {
  const cookie = await loginOver(
    makeEnv({ APP_URL: 'https://configured.example' }),
    'http://localhost:8787/login',
  );
  assert.match(cookie, /Secure/);
});

// ─── Passkey relying-party parameters ────────────────────────────────────────

async function passkeyRegisterOptions(ctx: TestEnv, url: string) {
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'correct-password',
  });
  const token = await accessTokenFor({
    id: 'u1',
    email: 'alice@example.com',
    role: 'user',
    tokenVersion: 0,
  });
  const res = await request(
    auth,
    url,
    { method: 'POST', headers: await bearer(token) },
    ctx,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    options: { rp: { id: string; name: string } };
  };
  return body.options.rp;
}

test('Passkey options：未配 RP_ID/APP_ORIGIN 时 rpID 用请求 hostname', async () => {
  const rp = await passkeyRegisterOptions(
    makeEnvWithoutAppVars(),
    'https://go.example.com:8443/2fa/passkey/register-options',
  );
  assert.equal(rp.id, 'go.example.com');
  assert.equal(rp.name, 'Hop');
});

test('Passkey options：配了 RP_ID 时 rpID 用 env 值', async () => {
  const rp = await passkeyRegisterOptions(
    makeEnv({
      RP_ID: 'configured.example',
      APP_ORIGIN: 'https://configured.example',
    }),
    'https://go.example.com/2fa/passkey/register-options',
  );
  assert.equal(rp.id, 'configured.example');
});

// ─── App name: admin setting is the only source ──────────────────────────────

test('appName：settings 表有默认行时 /api/config 与 rpName 都是 Hop', async () => {
  const ctx = makeEnvWithoutAppVars();
  const config = await request(
    app,
    'https://go.example.com/api/config',
    { method: 'GET' },
    ctx,
  );
  const body = (await config.json()) as { appName: string };
  assert.equal(body.appName, 'Hop');

  const rp = await passkeyRegisterOptions(
    ctx,
    'https://go.example.com/2fa/passkey/register-options',
  );
  assert.equal(rp.name, 'Hop');
});

test('appName：settings 表连默认行都没有时落到常量默认 Hop', async () => {
  const ctx = makeEnvWithoutAppVars();
  ctx.db.prepare("DELETE FROM settings WHERE key = 'app_name'").run();

  const config = await request(
    app,
    'https://go.example.com/api/config',
    { method: 'GET' },
    ctx,
  );
  assert.equal(((await config.json()) as { appName: string }).appName, 'Hop');

  const rp = await passkeyRegisterOptions(
    ctx,
    'https://go.example.com/2fa/passkey/register-options',
  );
  assert.equal(rp.name, 'Hop');
});

test('appName：管理面改 app_name 后 /api/config 与 rpName 同步生效（缓存失效）', async () => {
  const ctx = makeEnvWithoutAppVars();
  await seedUser(ctx.db, {
    id: 'admin1',
    email: 'admin@example.com',
    username: 'admin',
    role: 'admin',
    isActive: 1,
    tokenVersion: 0,
    password: 'admin-password',
  });
  const adminToken = await accessTokenFor({
    id: 'admin1',
    email: 'admin@example.com',
    role: 'admin',
    tokenVersion: 0,
  });

  // Warm the KV cache with the default first, so the rename below proves the
  // cache is invalidated rather than merely cold.
  const before = await request(
    app,
    'https://go.example.com/api/config',
    { method: 'GET' },
    ctx,
  );
  assert.equal(((await before.json()) as { appName: string }).appName, 'Hop');

  const put = await request(
    admin,
    'https://go.example.com/settings',
    {
      method: 'PUT',
      headers: {
        ...(await bearer(adminToken)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ app_name: 'MyHop' }),
    },
    ctx,
  );
  assert.equal(put.status, 200);

  const after = await request(
    app,
    'https://go.example.com/api/config',
    { method: 'GET' },
    ctx,
  );
  assert.equal(((await after.json()) as { appName: string }).appName, 'MyHop');

  const rp = await passkeyRegisterOptions(
    ctx,
    'https://go.example.com/2fa/passkey/register-options',
  );
  assert.equal(rp.name, 'MyHop');
});

test('appName：APP_NAME 已从 Env 移除，不再影响解析结果', async () => {
  const ctx = makeEnvWithoutAppVars({
    // A stale deployment could still have the old variable configured in the CF
    // dashboard; it must be ignored now that the admin setting is authoritative.
    APP_NAME: 'StaleEnvName',
  } as unknown as Partial<Env>);
  const name = await appName(ctx.env);
  assert.equal(name, 'Hop');
});

test('四项全配时：appUrl/rpId/appOrigin 与改前 env 直读完全一致', async () => {
  const ctx = makeEnv();
  const values = await probeValues(ctx, 'https://go.example.com/probe');
  assert.equal(values.appUrl, APP_URL);
  assert.equal(values.rpId, 'example.com');
  assert.equal(values.appOrigin, APP_URL);
});
