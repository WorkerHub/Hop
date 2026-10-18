// BE-Q2: links critical-path tests — create (validation), update, and
// ownership/permission checks. Real auth middleware (JWT + D1) is exercised.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import links from '../src/routes/links.ts';
import { accessTokenFor, makeEnv, request, seedUser } from './helpers/app.ts';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function setupUsers(ctx: Awaited<ReturnType<typeof makeEnv>>) {
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'alice@example.com',
    username: 'alice',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'password-1',
  });
  await seedUser(ctx.db, {
    id: 'u2',
    email: 'bob@example.com',
    username: 'bob',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'password-2',
  });
  const alice = await accessTokenFor({
    id: 'u1',
    email: 'alice@example.com',
    role: 'user',
    tokenVersion: 0,
  });
  const bob = await accessTokenFor({
    id: 'u2',
    email: 'bob@example.com',
    role: 'user',
    tokenVersion: 0,
  });
  return { alice, bob };
}

test('POST /: 创建合法链接返回 201 并分配 slug', async () => {
  const ctx = makeEnv();
  const { alice } = await setupUsers(ctx);

  const res = await request(
    links,
    '/',
    json(
      { destinationUrl: 'https://example.org/page' },
      { Authorization: `Bearer ${alice}` },
    ),
    ctx,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.link.id, 'expected a link id');
  assert.ok(body.link.slug, 'expected a generated slug');
  assert.equal(body.link.destination_url, 'https://example.org/page');
  assert.equal(body.link.user_seq, 1);
});

test('POST /: 拒绝非 http/https 协议（javascript:）', async () => {
  const ctx = makeEnv();
  const { alice } = await setupUsers(ctx);

  const res = await request(
    links,
    '/',
    json(
      { destinationUrl: 'javascript:alert(1)' },
      { Authorization: `Bearer ${alice}` },
    ),
    ctx,
  );
  assert.equal(res.status, 400);
});

test('POST /: 拒绝保留 slug', async () => {
  const ctx = makeEnv();
  const { alice } = await setupUsers(ctx);

  const res = await request(
    links,
    '/',
    json(
      { destinationUrl: 'https://example.org', customSlug: 'dashboard' },
      { Authorization: `Bearer ${alice}` },
    ),
    ctx,
  );
  assert.equal(res.status, 400);
});

test('权限: 其他用户读取该链接返回 404', async () => {
  const ctx = makeEnv();
  const { alice, bob } = await setupUsers(ctx);

  const created = await request(
    links,
    '/',
    json(
      { destinationUrl: 'https://example.org/page' },
      { Authorization: `Bearer ${alice}` },
    ),
    ctx,
  );
  const id = (await created.json()).link.id as string;

  const res = await request(
    links,
    `/${id}`,
    { method: 'GET', headers: { Authorization: `Bearer ${bob}` } },
    ctx,
  );
  assert.equal(res.status, 404);
});

test('PUT /:id: 所有者可更新，其他用户更新返回 404', async () => {
  const ctx = makeEnv();
  const { alice, bob } = await setupUsers(ctx);

  const created = await request(
    links,
    '/',
    json(
      { destinationUrl: 'https://example.org/page' },
      { Authorization: `Bearer ${alice}` },
    ),
    ctx,
  );
  const id = (await created.json()).link.id as string;

  const byOwner = await request(
    links,
    `/${id}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice}`,
      },
      body: JSON.stringify({ title: 'new title' }),
    },
    ctx,
  );
  assert.equal(byOwner.status, 200);
  assert.equal((await byOwner.json()).link.title, 'new title');

  const byOther = await request(
    links,
    `/${id}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bob}`,
      },
      body: JSON.stringify({ title: 'hijacked' }),
    },
    ctx,
  );
  assert.equal(byOther.status, 404);
});

test('DELETE /:id: 其他用户删除返回 404', async () => {
  const ctx = makeEnv();
  const { alice, bob } = await setupUsers(ctx);

  const created = await request(
    links,
    '/',
    json(
      { destinationUrl: 'https://example.org/page' },
      { Authorization: `Bearer ${alice}` },
    ),
    ctx,
  );
  const id = (await created.json()).link.id as string;

  const res = await request(
    links,
    `/${id}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${bob}` } },
    ctx,
  );
  assert.equal(res.status, 404);
});
