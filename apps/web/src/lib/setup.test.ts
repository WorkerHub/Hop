import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { ApiRequestError, adminApi, setupApi } from '../api/client.ts';
import { en } from '../i18n/locales/en.ts';
import { zhCN } from '../i18n/locales/zh-CN.ts';
import { resolveSetupError } from './setup.ts';

// Setup/upgrade frontend behaviour, pinned down with a stubbed fetch and pure
// helpers (same style as client.test.ts and apiErrorCodes.test.ts — no extra
// test dependencies). Covers the public /setup page state, migration results,
// the 429 Retry-After mapping, and the admin "check & upgrade" action.

const originalFetch = globalThis.fetch;

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('setupApi.state', () => {
  test('reports disabled when the backend says enabled=false', async () => {
    mockFetch((url) => {
      assert.match(url, /\/api\/setup\/state$/);
      return jsonResponse({ enabled: false });
    });

    assert.equal((await setupApi.state()).enabled, false);
  });

  test('reports enabled', async () => {
    mockFetch((url) => {
      assert.match(url, /\/api\/setup\/state$/);
      return jsonResponse({ enabled: true });
    });

    assert.equal((await setupApi.state()).enabled, true);
  });
});

describe('setupApi.run', () => {
  test('returns migration results on success and sends the secret in the body', async () => {
    const calls = mockFetch((url, init) => {
      assert.match(url, /\/api\/setup$/);
      assert.equal(JSON.parse(String(init?.body)).secret, 'top-secret');
      return jsonResponse({
        migrations: [
          { name: 'schema_v1', status: 'applied' },
          { name: 'schema_v2', status: 'skipped' },
        ],
      });
    });

    const result = await setupApi.run('top-secret');
    assert.equal(calls.length, 1);
    assert.deepEqual(
      result.migrations.map((m) => m.status),
      ['applied', 'skipped'],
    );
  });

  test('surfaces Retry-After seconds on a 429', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'Too many setup attempts.' }), {
          status: 429,
          headers: { 'Retry-After': '120', 'Content-Type': 'application/json' },
        }),
    );

    await assert.rejects(setupApi.run('secret'), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 120);
      return true;
    });
  });
});

describe('adminApi.runSetup', () => {
  test('returns migration results on success', async () => {
    const calls = mockFetch((url, init) => {
      assert.match(url, /\/api\/admin\/setup$/);
      assert.equal(init?.method, 'POST');
      return jsonResponse({
        migrations: [
          { name: 'schema_v1', status: 'skipped' },
          { name: 'schema_v2', status: 'error', error: 'boom' },
        ],
      });
    });

    const result = await adminApi.runSetup();
    assert.equal(calls.length, 1);
    assert.equal(result.migrations[1]?.status, 'error');
    assert.equal(result.migrations[1]?.error, 'boom');
  });
});

describe('resolveSetupError', () => {
  test('maps a 429 with Retry-After to the localized too-many-requests key', () => {
    assert.deepEqual(resolveSetupError({ status: 429, retryAfter: 120 }), {
      kind: 'i18n',
      key: 'setup.errorTooManyRequests',
      params: { seconds: 120 },
    });
  });

  test('maps 400, 403, 404 and 500 to their status keys', () => {
    assert.deepEqual(resolveSetupError({ status: 400 }), {
      kind: 'i18n',
      key: 'setup.errorBadRequest',
    });
    assert.deepEqual(resolveSetupError({ status: 403 }), {
      kind: 'i18n',
      key: 'setup.errorForbidden',
    });
    assert.deepEqual(resolveSetupError({ status: 404 }), {
      kind: 'i18n',
      key: 'setup.errorNotFound',
    });
    assert.deepEqual(resolveSetupError({ status: 500 }), {
      kind: 'i18n',
      key: 'setup.errorServer',
    });
  });

  test('falls back to the raw backend message for unmatched errors', () => {
    assert.deepEqual(resolveSetupError(new Error('boom')), {
      kind: 'raw',
      message: 'boom',
    });
  });

  test('maps a known backend code through API_ERROR_CODES', () => {
    assert.deepEqual(
      resolveSetupError({ status: 400, code: 'REGISTRATION_DISABLED' }),
      { kind: 'i18n', key: 'errors.registrationDisabled' },
    );
  });
});

describe('setup i18n keys', () => {
  function resolve(obj: unknown, path: string): unknown {
    let curr = obj;
    for (const p of path.split('.')) {
      if (curr == null || typeof curr !== 'object') return undefined;
      curr = (curr as Record<string, unknown>)[p];
    }
    return curr;
  }

  test('resolve to non-empty strings in both locales', () => {
    const keys = [
      'setup.title',
      'setup.disabledTitle',
      'setup.disabledDesc',
      'setup.errorBadRequest',
      'setup.errorForbidden',
      'setup.errorTooManyRequests',
      'setup.errorServer',
      'setup.errorNotFound',
      'setup.statusApplied',
      'setup.statusSkipped',
      'setup.statusError',
      'admin.setupPageToggle',
      'admin.setupPageDesc',
      'admin.runSetup',
      'toast.setupPageEnabled',
      'toast.setupPageDisabled',
    ];
    for (const key of keys) {
      assert.equal(typeof resolve(en, key), 'string', `${key} (en) is missing`);
      assert.equal(
        typeof resolve(zhCN, key),
        'string',
        `${key} (zh-CN) is missing`,
      );
      assert.ok((resolve(en, key) as string).length > 0, `${key} (en) empty`);
      assert.ok((resolve(zhCN, key) as string).length > 0, `${key} (zh) empty`);
    }
  });
});
