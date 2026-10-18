// Admin "send test email" endpoint tests — POST /api/admin/email/test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from '../src/index.ts';
import { accessTokenFor, makeEnv, request, seedUser } from './helpers/app.ts';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function seedAdmin(ctx: ReturnType<typeof makeEnv>): Promise<string> {
  await seedUser(ctx.db, {
    id: 'a1',
    email: 'admin@example.com',
    username: 'admin',
    role: 'admin',
    isActive: 1,
    tokenVersion: 0,
    password: 'password-1',
  });
  return accessTokenFor({
    id: 'a1',
    email: 'admin@example.com',
    role: 'admin',
    tokenVersion: 0,
  });
}

function configureResend(ctx: ReturnType<typeof makeEnv>): void {
  ctx.db
    .prepare("UPDATE settings SET value = ?1 WHERE key = 'resend_api_key'")
    .bind('test-key')
    .run();
  ctx.db
    .prepare("UPDATE settings SET value = ?1 WHERE key = 'email_from_domain'")
    .bind('example.com')
    .run();
}

test('POST /api/admin/email/test: 未认证 401 / 非管理员 403', async () => {
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
  const userToken = await accessTokenFor({
    id: 'u1',
    email: 'bob@example.com',
    role: 'user',
    tokenVersion: 0,
  });

  const noAuth = await request(
    app,
    '/api/admin/email/test',
    json({ to: 'a@b.com' }),
    ctx,
  );
  assert.equal(noAuth.status, 401);

  const asUser = await request(
    app,
    '/api/admin/email/test',
    json({ to: 'a@b.com' }, { Authorization: `Bearer ${userToken}` }),
    ctx,
  );
  assert.equal(asUser.status, 403);
});

test('POST /api/admin/email/test: 非法邮箱返回 400', async () => {
  const ctx = makeEnv();
  const token = await seedAdmin(ctx);

  const cases: [unknown, string][] = [
    [undefined, '缺少 to'],
    ['', '空字符串'],
    ['not-an-email', '无 @'],
    ['a@b', '无域名后缀'],
    [`${'a'.repeat(250)}@example.com`, '长度超 254'],
  ];
  for (const [to, label] of cases) {
    const res = await request(
      app,
      '/api/admin/email/test',
      json({ to }, { Authorization: `Bearer ${token}` }),
      ctx,
    );
    assert.equal(res.status, 400, `${label} 应返回 400`);
  }
});

test('POST /api/admin/email/test: 配置缺失返回 400 且提示可读', async () => {
  const ctx = makeEnv();
  const token = await seedAdmin(ctx);

  const res = await request(
    app,
    '/api/admin/email/test',
    json({ to: 'user@example.com' }, { Authorization: `Bearer ${token}` }),
    ctx,
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /not configured/);
  assert.doesNotMatch(body.error, /test-key/);
});

test('POST /api/admin/email/test: 上游失败返回 502 且不泄露上游响应', async (t) => {
  const ctx = makeEnv();
  const token = await seedAdmin(ctx);
  configureResend(ctx);

  const SECRET = 'SUPER-SECRET-UPSTREAM-BODY';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: SECRET }), { status: 500 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const res = await request(
    app,
    '/api/admin/email/test',
    json({ to: 'user@example.com' }, { Authorization: `Bearer ${token}` }),
    ctx,
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'Failed to send test email');
  assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET));
});

test('POST /api/admin/email/test: 成功发送 200 并写审计日志', async (t) => {
  const ctx = makeEnv();
  const token = await seedAdmin(ctx);
  configureResend(ctx);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"id":"ok"}', { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const res = await request(
    app,
    '/api/admin/email/test',
    json({ to: 'user@example.com' }, { Authorization: `Bearer ${token}` }),
    ctx,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });

  const row = ctx.db
    .prepare(
      `SELECT action, target_id, details FROM audit_logs WHERE action = 'test_email'`,
    )
    .first<{ action: string; target_id: string; details: string }>();
  assert.ok(row, '应写入 test_email 审计日志');
  assert.equal(row?.target_id, 'email');
  assert.deepEqual(JSON.parse(row?.details ?? '{}'), {
    to: 'user@example.com',
  });
});

test('POST /api/admin/email/test: 第 6 次限流 429 + Retry-After', async (t) => {
  const ctx = makeEnv();
  const token = await seedAdmin(ctx);
  configureResend(ctx);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"id":"ok"}', { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (let i = 0; i < 5; i++) {
    const res = await request(
      app,
      '/api/admin/email/test',
      json({ to: 'user@example.com' }, { Authorization: `Bearer ${token}` }),
      ctx,
    );
    assert.equal(res.status, 200, `第 ${i + 1} 次应成功`);
  }

  const blocked = await request(
    app,
    '/api/admin/email/test',
    json({ to: 'user@example.com' }, { Authorization: `Bearer ${token}` }),
    ctx,
  );
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get('Retry-After'));
  assert.ok(
    Number.isFinite(retryAfter) && retryAfter > 0,
    'Retry-After 应为正数',
  );
});
