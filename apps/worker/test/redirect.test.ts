// BE-Q2: redirect critical-path tests — active redirect, expired link, and
// deactivated link all fall back to /404; missing slug too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import redirect from '../src/routes/redirect.ts';
import { APP_URL, makeEnv, request, seedUser } from './helpers/app.ts';

function insertLink(
  ctx: Awaited<ReturnType<typeof makeEnv>>,
  fields: {
    id: string;
    slug: string;
    isActive: number;
    expiresAt: number | null;
  },
): void {
  ctx.db
    .prepare(
      `INSERT INTO links (id, user_id, slug, destination_url, title, expires_at, is_active, user_seq)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 1)`,
    )
    .bind(
      fields.id,
      'u1',
      fields.slug,
      'https://example.org/target',
      fields.expiresAt,
      fields.isActive,
    )
    .run();
}

async function setup(ctx: Awaited<ReturnType<typeof makeEnv>>) {
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'password-1',
  });
}

test('redirect: 活动链接 302 跳转到目标地址', async () => {
  const ctx = makeEnv();
  await setup(ctx);
  insertLink(ctx, { id: 'l1', slug: 'abc', isActive: 1, expiresAt: null });

  const res = await request(redirect, '/abc', { method: 'GET' }, ctx);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://example.org/target');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
});

test('redirect: 过期链接跳转到 /404', async () => {
  const ctx = makeEnv();
  await setup(ctx);
  const past = Math.floor(Date.now() / 1000) - 100;
  insertLink(ctx, { id: 'l1', slug: 'expired', isActive: 1, expiresAt: past });

  const res = await request(redirect, '/expired', { method: 'GET' }, ctx);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `${APP_URL}/404`);
});

test('redirect: 停用链接跳转到 /404', async () => {
  const ctx = makeEnv();
  await setup(ctx);
  insertLink(ctx, { id: 'l1', slug: 'off', isActive: 0, expiresAt: null });

  const res = await request(redirect, '/off', { method: 'GET' }, ctx);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `${APP_URL}/404`);
});

test('redirect: 不存在的 slug 跳转到 /404', async () => {
  const ctx = makeEnv();
  await setup(ctx);

  const res = await request(redirect, '/missing', { method: 'GET' }, ctx);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `${APP_URL}/404`);
});
