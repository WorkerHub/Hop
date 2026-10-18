// Security-header tests: HSTS gating on the APP_URL scheme, the SPA CSP nonce
// used to let Cloudflare's JavaScript Detections (Bot Fight Mode) run, and the
// minimal security headers on short-link redirects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from '../src/index.ts';
import { API_CSP, HSTS, securityHeaders, spaCsp } from '../src/lib/security.ts';
import redirect from '../src/routes/redirect.ts';
import { makeEnv, request } from './helpers/app.ts';

test('spaCsp 无 nonce 时不含 nonce 指令', () => {
  const csp = spaCsp();
  assert.match(csp, /script-src 'self' 'unsafe-eval'/);
  assert.doesNotMatch(csp, /nonce-/);
});

test('spaCsp 带 nonce 时在 script-src 追加 nonce 指令', () => {
  const csp = spaCsp('abc123');
  assert.match(csp, /script-src 'self' 'unsafe-eval' 'nonce-abc123'/);
});

test('securityHeaders 在 https APP_URL 下附带 HSTS', () => {
  const headers = securityHeaders('https://example.com', API_CSP);
  assert.equal(headers['Strict-Transport-Security'], HSTS);
});

test('securityHeaders 在 http APP_URL 下不附带 HSTS', () => {
  const headers = securityHeaders('http://localhost:8787', API_CSP);
  assert.equal(headers['Strict-Transport-Security'], undefined);
});

test('securityHeaders 对带前导/尾随空格的 https APP_URL 归一化后仍发 HSTS', () => {
  const headers = securityHeaders(' https://go.example.com ', API_CSP);
  assert.equal(headers['Strict-Transport-Security'], HSTS);
});

test('SPA HTML 响应携带带 nonce 的 CSP（供 Cloudflare JS detections 使用）', async () => {
  const ctx = makeEnv({
    ASSETS: {
      fetch: async () =>
        new Response('<!doctype html><html><body></body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    },
  });
  const res = await request(app, '/login', { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self' 'unsafe-eval' 'nonce-/);
});

test('连续两次 SPA HTML 请求的 nonce 互不相同', async () => {
  const ctx = makeEnv({
    ASSETS: {
      fetch: async () =>
        new Response('<!doctype html><html><body></body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    },
  });
  const csp1 =
    (await request(app, '/login', { method: 'GET' }, ctx)).headers.get(
      'content-security-policy',
    ) ?? '';
  const csp2 =
    (await request(app, '/login', { method: 'GET' }, ctx)).headers.get(
      'content-security-policy',
    ) ?? '';
  const nonce1 = csp1.match(/nonce-([\w-]+)/)?.[1];
  const nonce2 = csp2.match(/nonce-([\w-]+)/)?.[1];
  assert.ok(nonce1, '第一次请求应带 nonce');
  assert.ok(nonce2, '第二次请求应带 nonce');
  assert.notEqual(nonce1, nonce2);
});

test('API 响应（/api/health）CSP 不包含 nonce', async () => {
  const ctx = makeEnv();
  const res = await request(app, '/api/health', { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.equal(csp, API_CSP);
  assert.doesNotMatch(csp, /nonce-/);
});

test('APP_URL 带前导空格时 CORS 仍回显匹配的 Origin', async () => {
  const ctx = makeEnv({ APP_URL: ' https://example.com' });
  const res = await request(
    app,
    '/api/config',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET',
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

test('静态资源响应不附带 nonce 的 CSP', async () => {
  const ctx = makeEnv({
    ASSETS: {
      fetch: async () =>
        new Response('export default {};', {
          headers: { 'content-type': 'text/javascript' },
        }),
    },
  });
  const res = await request(app, '/assets/app.js', { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self' 'unsafe-eval'/);
  assert.doesNotMatch(csp, /nonce-/);
});

test('短链 302 响应附带 HSTS 与 no-referrer（https APP_URL）', async () => {
  const ctx = makeEnv();
  const res = await request(redirect, '/missing', { method: 'GET' }, ctx);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Strict-Transport-Security'), HSTS);
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
});

test('短链 302 响应在 http APP_URL 下不附带 HSTS', async () => {
  const ctx = makeEnv({ APP_URL: 'http://localhost:8787' });
  const res = await request(redirect, '/missing', { method: 'GET' }, ctx);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Strict-Transport-Security'), null);
  assert.equal(res.headers.get('Location'), 'http://localhost:8787/404');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
});
