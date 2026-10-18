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
