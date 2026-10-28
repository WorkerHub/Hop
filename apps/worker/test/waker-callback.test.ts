// Waker callback path (spec v1.0 §2/§4): signature verification, replay
// window, executionId deduplication, fail-closed behaviour without a signing
// key, and the explicit 404 whenever the integration is off.
//
// The request is signed here with WebCrypto exactly as documented by the
// frozen protocol (`<timestamp>\n<executionId>\n<jobId>\n<rawBody>`, HMAC-SHA256,
// `v2=<hex>`), so the test exercises the wire contract rather than an internal
// shortcut.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { app } from '../src/index.ts';
import { tbl } from '../src/lib/db.ts';
import {
  WAKER_JOB_CRON,
  WAKER_JOB_NIGHTLY_CLEANUP,
} from '../src/services/waker.ts';
import type { Env } from '../src/types.ts';
import { CALLBACK_MOUNT_PATH } from '../src/waker/index.ts';
import { makeEnv, request, type TestEnv } from './helpers/app.ts';
import { D1Mock } from './helpers/env.ts';

const SIGNING_KEY = 'waker-test-signing-key-not-a-real-value';
const JOB_ID = '9b1f0d6e-6a4f-4b1e-9f2c-1d0c3a5e7b11';
const PROJECT_ID = '6a2c9f5d-3e8b-4a71-8c0d-5b2f7e9a1c33';
const encoder = new TextEncoder();

interface SignedRequestInput {
  executionId?: string;
  jobName?: string;
  jobId?: string;
  /** Epoch seconds written into X-Waker-Timestamp and covered by the signature. */
  timestamp?: number;
  key?: string;
  bodyOverride?: string;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

interface SignedRequest {
  body: string;
  headers: Record<string, string>;
}

async function signedRequest(
  input: SignedRequestInput = {},
): Promise<SignedRequest> {
  const executionId = input.executionId ?? crypto.randomUUID();
  const jobId = input.jobId ?? JOB_ID;
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const body =
    input.bodyOverride ??
    JSON.stringify({
      protocolVersion: 2,
      executionId,
      jobId,
      projectId: PROJECT_ID,
      jobName: input.jobName ?? WAKER_JOB_NIGHTLY_CLEANUP,
      kind: 'cron',
      trigger: 'schedule',
      misfire: false,
      attempt: 0,
      scheduledFor: Date.now(),
      dispatchedAt: Date.now(),
      timeoutSeconds: 30,
      payload: null,
    });
  const signature = await hmacHex(
    input.key ?? SIGNING_KEY,
    `${timestamp}\n${executionId}\n${jobId}\n${body}`,
  );
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'X-Waker-Timestamp': String(timestamp),
      'X-Waker-Execution-Id': executionId,
      'X-Waker-Job-Id': jobId,
      'X-Waker-Signature': `v2=${signature}`,
    },
  };
}

function wakerEnv(overrides: Partial<Env> = {}, prefix = 'hop'): TestEnv {
  return makeEnv({
    DB: new D1Mock(true, prefix) as unknown as Env['DB'],
    TABLE_PREFIX: prefix,
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://waker.example.com',
    WAKER_SIGNING_KEY: SIGNING_KEY,
    ...overrides,
  });
}

function seedExpiredRows(ctx: TestEnv, prefix = 'hop'): void {
  const envLike = { TABLE_PREFIX: prefix };
  ctx.env.DB.prepare(
    `INSERT INTO ${tbl(envLike, 'verifications')} (identifier, type, code_hash, expires_at)
     VALUES ('old@example.com', 'email_otp', 'hash-old', unixepoch() - 10)`,
  ).run();
  ctx.env.DB.prepare(
    `INSERT INTO ${tbl(envLike, 'verifications')} (identifier, type, code_hash, expires_at)
     VALUES ('fresh@example.com', 'email_otp', 'hash-fresh', unixepoch() + 3600)`,
  ).run();
  ctx.env.DB.prepare(
    `INSERT INTO ${tbl(envLike, 'totp_used')} (user_id, code, used_at)
     VALUES ('u1', '111111', unixepoch() - 91)`,
  ).run();
  ctx.env.DB.prepare(
    `INSERT INTO ${tbl(envLike, 'totp_used')} (user_id, code, used_at)
     VALUES ('u1', '222222', unixepoch() - 5)`,
  ).run();
}

function countRows(ctx: TestEnv, table: string, prefix = 'hop'): number {
  const row = ctx.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${tbl({ TABLE_PREFIX: prefix }, table)}`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

function callbackPath(): string {
  return `${CALLBACK_MOUNT_PATH}/execute`;
}

// ─── when the integration is off, the path must answer 404 explicitly ────────

for (const scenario of [
  { name: 'WAKER_MODE 未设置（默认 cron）', mode: undefined, url: undefined },
  { name: 'WAKER_MODE=cron', mode: 'cron', url: 'https://waker.example.com' },
  {
    name: 'WAKER_MODE=waker 但 WAKER_URL 缺失（receiver 自动关闭）',
    mode: 'waker',
    url: undefined,
  },
]) {
  test(`非 waker 运行时 ${scenario.name} → /_waker/execute 显式 404，不是 SPA 200`, async () => {
    const ctx = makeEnv({
      WAKER_MODE: scenario.mode,
      WAKER_URL: scenario.url,
      WAKER_SIGNING_KEY: SIGNING_KEY,
    });
    const signed = await signedRequest();
    const res = await request(
      app,
      callbackPath(),
      { method: 'POST', headers: signed.headers, body: signed.body },
      ctx,
    );
    // ASSETS (the SPA fallback) would answer 200 'assets'; waker reads any 2xx
    // as a successful execution, so this must be a JSON 404 instead.
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json();
    assert.equal(body.code, 'waker_disabled');
    assert.equal(countRows(ctx, 'verifications', ''), 0);
  });
}

test('GET /_waker（无 /execute）也是 JSON 404，不落到短链路由或 SPA', async () => {
  const ctx = wakerEnv();
  const res = await request(app, CALLBACK_MOUNT_PATH, { method: 'GET' }, ctx);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

// ─── happy path: same cleanup as the native trigger, counts in the response ──

test('验签通过 → 执行清理、返回计数、executionId 落 {prefix}waker_executions', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const signed = await signedRequest({ executionId: 'exec-ok-1' });

  const res = await request(
    app,
    callbackPath(),
    { method: 'POST', headers: signed.headers, body: signed.body },
    ctx,
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.cleanup.verifications, 1);
  assert.deepEqual(body.cleanup.totpUsed, 1);
  assert.equal(typeof body.cleanup.durationMs, 'number');

  // Only the expired rows went away; the live ones are untouched.
  assert.equal(countRows(ctx, 'verifications'), 1);
  assert.equal(countRows(ctx, 'totp_used'), 1);
  // Ledger row written under the TABLE_PREFIX-derived name.
  assert.equal(countRows(ctx, 'waker_executions'), 1);
});

test('回调日志含清理计数与耗时，且不含 signing key', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const signed = await signedRequest();
  const lines: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  }
  try {
    const res = await request(
      app,
      callbackPath(),
      { method: 'POST', headers: signed.headers, body: signed.body },
      ctx,
    );
    assert.equal(res.status, 200);
  } finally {
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  const joined = lines.join('\n');
  assert.match(joined, /"event":"nightly_cleanup"/);
  assert.match(joined, /"source":"waker"/);
  assert.match(joined, /"verifications":1/);
  assert.match(joined, /"totpUsed":1/);
  assert.match(joined, /"durationMs":\d+/);
  assert.ok(!joined.includes(SIGNING_KEY), '日志不得包含 signing key');
});

// ─── negative cases: verify failures change nothing ──────────────────────────

test('签名被篡改 → 401 invalid_signature，清理不执行', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const signed = await signedRequest();
  const signature = signed.headers['X-Waker-Signature'] ?? '';
  const tampered = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;

  const res = await request(
    app,
    callbackPath(),
    {
      method: 'POST',
      headers: { ...signed.headers, 'X-Waker-Signature': tampered },
      body: signed.body,
    },
    ctx,
  );

  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'invalid_signature');
  assert.equal(countRows(ctx, 'verifications'), 2);
  assert.equal(countRows(ctx, 'totp_used'), 2);
  assert.equal(countRows(ctx, 'waker_executions'), 0);
});

test('时间戳超出 300s 窗口 → 401 stale_timestamp，清理不执行', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const signed = await signedRequest({
    timestamp: Math.floor(Date.now() / 1000) - 301,
  });

  const res = await request(
    app,
    callbackPath(),
    { method: 'POST', headers: signed.headers, body: signed.body },
    ctx,
  );

  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'stale_timestamp');
  assert.equal(countRows(ctx, 'verifications'), 2);
  assert.equal(countRows(ctx, 'waker_executions'), 0);
});

test('用错的 signing key 签名 → 401，清理不执行', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const signed = await signedRequest({ key: 'not-the-project-key' });

  const res = await request(
    app,
    callbackPath(),
    { method: 'POST', headers: signed.headers, body: signed.body },
    ctx,
  );

  assert.equal(res.status, 401);
  assert.equal(countRows(ctx, 'verifications'), 2);
});

test('body 的 executionId 与签名头不一致 → 400，清理不执行', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const signed = await signedRequest({ executionId: 'exec-header' });
  const body = JSON.parse(signed.body);
  body.executionId = 'exec-body';
  // Re-sign the swapped body so only the header/body identity check can fail.
  const timestamp = signed.headers['X-Waker-Timestamp'] ?? '';
  const jobId = signed.headers['X-Waker-Job-Id'] ?? '';
  const swapped = JSON.stringify(body);
  const signature = await hmacHex(
    SIGNING_KEY,
    `${timestamp}\nexec-header\n${jobId}\n${swapped}`,
  );

  const res = await request(
    app,
    callbackPath(),
    {
      method: 'POST',
      headers: { ...signed.headers, 'X-Waker-Signature': `v2=${signature}` },
      body: swapped,
    },
    ctx,
  );

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_request');
  assert.equal(countRows(ctx, 'verifications'), 2);
});

test('未声明的任务名（与 waker 管理面注册名不一致）→ 404 unknown_job，清理不执行', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const signed = await signedRequest({ jobName: 'nightly-cleanup-typo' });

  const res = await request(
    app,
    callbackPath(),
    { method: 'POST', headers: signed.headers, body: signed.body },
    ctx,
  );

  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'unknown_job');
  assert.equal(countRows(ctx, 'verifications'), 2);
});

test('waker 模式但缺 WAKER_SIGNING_KEY → 500 signing_key_missing（失败关闭，不裸奔执行）', async () => {
  const ctx = wakerEnv({ WAKER_SIGNING_KEY: undefined });
  seedExpiredRows(ctx);
  const signed = await signedRequest();

  const res = await request(
    app,
    callbackPath(),
    { method: 'POST', headers: signed.headers, body: signed.body },
    ctx,
  );

  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'signing_key_missing');
  assert.equal(countRows(ctx, 'verifications'), 2);
  assert.equal(countRows(ctx, 'waker_executions'), 0);
});

// ─── replay + idempotency ────────────────────────────────────────────────────

test('同一 executionId 重放 → duplicate 且无副作用（清理不重跑）', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const signed = await signedRequest({ executionId: 'exec-replay' });
  const send = () =>
    request(
      app,
      callbackPath(),
      { method: 'POST', headers: signed.headers, body: signed.body },
      ctx,
    );

  const first = await send();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).cleanup.verifications, 1);

  // New expired rows appear after the first run: a replayed callback must not
  // touch them, proving the second delivery did no work at all.
  ctx.env.DB.prepare(
    `INSERT INTO ${tbl({ TABLE_PREFIX: 'hop' }, 'verifications')} (identifier, type, code_hash, expires_at)
     VALUES ('later@example.com', 'email_otp', 'hash-later', unixepoch() - 10)`,
  ).run();

  const second = await send();
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.duplicate, true);
  assert.equal(countRows(ctx, 'verifications'), 2); // fresh + later, none deleted
  assert.equal(countRows(ctx, 'waker_executions'), 1);
});

test('清理本身幂等：重跑第二次为无操作', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);
  const first = await signedRequest({ executionId: 'exec-rerun-1' });
  const second = await signedRequest({ executionId: 'exec-rerun-2' });

  const firstRes = await request(
    app,
    callbackPath(),
    { method: 'POST', headers: first.headers, body: first.body },
    ctx,
  );
  assert.equal((await firstRes.json()).cleanup.verifications, 1);

  const secondRes = await request(
    app,
    callbackPath(),
    { method: 'POST', headers: second.headers, body: second.body },
    ctx,
  );
  const body = await secondRes.json();
  assert.equal(body.cleanup.verifications, 0);
  assert.equal(body.cleanup.totpUsed, 0);
});

// ─── one business function, two entries ─────────────────────────────────────

test('原生 scheduled() 与回调共用同一清理函数（两条判据一致）', async () => {
  const ctx = wakerEnv();
  seedExpiredRows(ctx);

  await worker.scheduled(
    { cron: WAKER_JOB_CRON } as unknown as ScheduledController,
    ctx.env,
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );

  assert.equal(countRows(ctx, 'verifications'), 1);
  assert.equal(countRows(ctx, 'totp_used'), 1);
});
