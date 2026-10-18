// Setup endpoint tests — GET /api/setup/state (public), POST /api/setup (JSON
// body + legacy header, per-IP rate limit), GET /api/setup/* (405), and the
// admin keyless upgrade POST /api/admin/setup (shared migration runner + audit).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from '../src/index.ts';
import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
} from '../src/lib/migrations.ts';
import type { Env } from '../src/types.ts';
import { accessTokenFor, makeEnv, request, seedUser } from './helpers/app.ts';
import { D1Mock } from './helpers/env.ts';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// Pre-records every migration as applied so a re-run returns "skipped" for all
// (the idempotent re-visit path), keeping assertions deterministic.
function markAllMigrationsApplied(db: D1Mock): void {
  db.prepare(createMigrationsTableSql('')).run();
  for (const migration of getMigrations('')) {
    db.prepare(`INSERT OR IGNORE INTO ${migrationsTable('')} (name) VALUES (?)`)
      .bind(migration.name)
      .run();
  }
}

// ─── GET /api/setup/state ─────────────────────────────────────────────────────

test('GET /api/setup/state: 缺省 enabled（无 setup_page_enabled 行）', async () => {
  const ctx = makeEnv();
  const res = await request(app, '/api/setup/state', { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: true });
});

test('GET /api/setup/state: setup_page_enabled=0 时 disabled', async () => {
  const ctx = makeEnv();
  ctx.db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('setup_page_enabled', '0')`,
    )
    .run();
  const res = await request(app, '/api/setup/state', { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: false });
});

test('GET /api/setup/state: settings 表不存在时 enabled', async () => {
  const ctx = makeEnv();
  ctx.db.exec('DROP TABLE settings');
  const res = await request(app, '/api/setup/state', { method: 'GET' }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: true });
});

// ─── GET /api/setup/* (legacy) ────────────────────────────────────────────────

test('GET /api/setup/*: 返回 405 + Allow: POST', async () => {
  const ctx = makeEnv();
  const res = await request(app, '/api/setup/anything', { method: 'GET' }, ctx);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'POST');
  const body = await res.json();
  assert.match(body.error, /POST \/api\/setup/);
});

test('GET /setup/*: 旧路径别名同样返回 405 + Allow: POST', async () => {
  const ctx = makeEnv();
  const res = await request(app, '/setup/anything', { method: 'GET' }, ctx);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'POST');
});

// ─── POST /api/setup ──────────────────────────────────────────────────────────

test('POST /api/setup: 正确 JSON 密钥把迁移应用到空库并返回结果', async () => {
  const ctx = makeEnv({ DB: new D1Mock(false) as unknown as Env['DB'] });
  const res = await request(
    app,
    '/api/setup',
    json({ secret: 'test-setup-secret' }, { 'cf-connecting-ip': '1.2.3.4' }),
    ctx,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.migrations.map((m: { name: string; status: string }) => [
      m.name,
      m.status,
    ]),
    [
      ['schema_v1', 'applied'],
      ['schema_v2', 'applied'],
    ],
  );
});

test('POST /api/setup: 密钥错误返回 403', async () => {
  const ctx = makeEnv();
  const res = await request(
    app,
    '/api/setup',
    json({ secret: 'wrong-secret' }, { 'cf-connecting-ip': '2.2.2.2' }),
    ctx,
  );
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Invalid setup secret/);
});

test('POST /api/setup: SETUP_SECRET 未配置返回 500', async () => {
  const ctx = makeEnv({ SETUP_SECRET: '' });
  const res = await request(
    app,
    '/api/setup',
    json({ secret: 'anything' }, { 'cf-connecting-ip': '3.3.3.3' }),
    ctx,
  );
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not configured/);
});

test('POST /api/setup: body 非法（secret 非字符串/为空）返回 400', async () => {
  const ctx = makeEnv();

  const nonString = await request(
    app,
    '/api/setup',
    json({ secret: 123 }, { 'cf-connecting-ip': '4.4.4.1' }),
    ctx,
  );
  assert.equal(nonString.status, 400);

  const empty = await request(
    app,
    '/api/setup',
    json({ secret: '' }, { 'cf-connecting-ip': '4.4.4.2' }),
    ctx,
  );
  assert.equal(empty.status, 400);
});

test('POST /api/setup: 旧 X-Setup-Secret 头方式仍可用', async () => {
  const ctx = makeEnv({ DB: new D1Mock(false) as unknown as Env['DB'] });
  const res = await request(
    app,
    '/api/setup',
    {
      method: 'POST',
      headers: {
        'X-Setup-Secret': 'test-setup-secret',
        'cf-connecting-ip': '5.5.5.5',
      },
    },
    ctx,
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).migrations));
});

test('POST /setup: 旧路径别名 + X-Setup-Secret 头仍可用', async () => {
  const ctx = makeEnv({ DB: new D1Mock(false) as unknown as Env['DB'] });
  const res = await request(
    app,
    '/setup',
    {
      method: 'POST',
      headers: {
        'X-Setup-Secret': 'test-setup-secret',
        'cf-connecting-ip': '5.5.5.6',
      },
    },
    ctx,
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).migrations));
});

test('POST /api/setup: 每 IP 每 10 分钟限 3 次，第 4 次 429 + Retry-After（计数先于密钥校验）', async () => {
  const ctx = makeEnv();
  const headers = {
    'Content-Type': 'application/json',
    'cf-connecting-ip': '9.9.9.9',
  };
  const body = JSON.stringify({ secret: 'wrong-secret' });

  // 前 3 次都用错误密钥：若计数发生在密钥校验之前，这 3 次会各自返回 403 并
  // 计入配额；第 4 次则因超限返回 429，而不是继续返回 403。
  for (let i = 0; i < 3; i++) {
    const res = await request(
      app,
      '/api/setup',
      { method: 'POST', headers, body },
      ctx,
    );
    assert.equal(res.status, 403, `第 ${i + 1} 次应为 403（密钥错误）`);
  }

  const res = await request(
    app,
    '/api/setup',
    { method: 'POST', headers, body },
    ctx,
  );
  assert.equal(res.status, 429);
  const retryAfter = Number(res.headers.get('Retry-After'));
  assert.ok(
    Number.isFinite(retryAfter) && retryAfter > 0,
    'Retry-After 应为正数',
  );
  assert.match((await res.json()).error, /Too many setup attempts/);
});

// ─── POST /api/admin/setup ────────────────────────────────────────────────────

test('POST /api/admin/setup: 非管理员被拒（未认证 401 / 非 admin 403）', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'u1',
    email: 'bob@example.com',
    username: 'bob',
    role: 'user',
    isActive: 1,
    tokenVersion: 0,
    password: 'password-1',
  });
  const token = await accessTokenFor({
    id: 'u1',
    email: 'bob@example.com',
    role: 'user',
    tokenVersion: 0,
  });

  const noAuth = await request(
    app,
    '/api/admin/setup',
    { method: 'POST' },
    ctx,
  );
  assert.equal(noAuth.status, 401);

  const asUser = await request(
    app,
    '/api/admin/setup',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    ctx,
  );
  assert.equal(asUser.status, 403);
});

test('POST /api/admin/setup: 管理员执行同一迁移逻辑并写审计日志', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'a1',
    email: 'admin@example.com',
    username: 'admin',
    role: 'admin',
    isActive: 1,
    tokenVersion: 0,
    password: 'password-1',
  });
  const token = await accessTokenFor({
    id: 'a1',
    email: 'admin@example.com',
    role: 'admin',
    tokenVersion: 0,
  });
  markAllMigrationsApplied(ctx.db);

  const res = await request(
    app,
    '/api/admin/setup',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    ctx,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.migrations.map((m: { status: string }) => m.status),
    ['skipped', 'skipped'],
  );

  const row = ctx.db
    .prepare(
      `SELECT action, target_id, details FROM audit_logs WHERE action = 'run_setup'`,
    )
    .first<{ action: string; target_id: string; details: string }>();
  assert.ok(row, '应写入 run_setup 审计日志');
  assert.equal(row?.target_id, 'setup');
  assert.deepEqual(JSON.parse(row?.details ?? '{}'), {
    applied: 0,
    skipped: 2,
    error: 0,
  });
});

// ─── 管理设置白名单 ───────────────────────────────────────────────────────────

test('PUT /api/admin/settings: 接受 setup_page_enabled，拒绝非法值', async () => {
  const ctx = makeEnv();
  await seedUser(ctx.db, {
    id: 'a1',
    email: 'admin@example.com',
    username: 'admin',
    role: 'admin',
    isActive: 1,
    tokenVersion: 0,
    password: 'password-1',
  });
  const token = await accessTokenFor({
    id: 'a1',
    email: 'admin@example.com',
    role: 'admin',
    tokenVersion: 0,
  });

  const bad = await request(
    app,
    '/api/admin/settings',
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ setup_page_enabled: '2' }),
    },
    ctx,
  );
  assert.equal(bad.status, 400);

  const good = await request(
    app,
    '/api/admin/settings',
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ setup_page_enabled: '0' }),
    },
    ctx,
  );
  assert.equal(good.status, 200);
  const row = ctx.db
    .prepare(`SELECT value FROM settings WHERE key = 'setup_page_enabled'`)
    .first<{ value: string }>();
  assert.equal(row?.value, '0');
});
