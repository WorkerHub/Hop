import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  ApiRequestError,
  adminApi,
  SessionExpiredError,
} from '../api/client.ts';
import { en } from '../i18n/locales/en.ts';
import { zhCN } from '../i18n/locales/zh-CN.ts';
import { formatTestEmailError, resolveTestEmailError } from './testEmail.ts';

// Admin "send test email" frontend behaviour, pinned down with a stubbed fetch
// and pure helpers (same style as setup.test.ts — no extra test dependencies).
// The AdminSettingsPage component is not rendered here; its error/success
// display logic is extracted into the pure functions asserted below.

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

describe('adminApi.sendTestEmail', () => {
  test('posts the recipient and returns success', async () => {
    const calls = mockFetch((url, init) => {
      assert.match(url, /\/api\/admin\/email\/test$/);
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { to: 'a@example.com' });
      return jsonResponse({ success: true });
    });

    const result = await adminApi.sendTestEmail('a@example.com');

    assert.equal(calls.length, 1);
    assert.equal(result.success, true);
  });

  test('surfaces the status and Retry-After seconds on a 429', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'Too many requests.' }), {
          status: 429,
          headers: { 'Retry-After': '30', 'Content-Type': 'application/json' },
        }),
    );

    await assert.rejects(
      adminApi.sendTestEmail('a@example.com'),
      (error: unknown) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfter, 30);
        return true;
      },
    );
  });

  test('surfaces the status on a 502 send failure', async () => {
    mockFetch(() => jsonResponse({ error: 'Failed to send' }, 502));

    await assert.rejects(
      adminApi.sendTestEmail('a@example.com'),
      (error: unknown) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.status, 502);
        return true;
      },
    );
  });
});

describe('resolveTestEmailError', () => {
  test('maps 400, 429 and 502 to their status keys', () => {
    assert.deepEqual(resolveTestEmailError({ status: 400 }), {
      key: 'admin.testEmailErrorBadRequest',
    });
    assert.deepEqual(resolveTestEmailError({ status: 502 }), {
      key: 'admin.testEmailErrorSendFailed',
    });
  });

  test('maps a 429 with Retry-After to the localized too-many-requests key', () => {
    assert.deepEqual(resolveTestEmailError({ status: 429, retryAfter: 45 }), {
      key: 'admin.testEmailErrorTooManyRequests',
      params: { seconds: 45 },
    });
  });

  test('falls back to the generic key for unmatched errors', () => {
    assert.deepEqual(resolveTestEmailError({ status: 500 }), {
      key: 'admin.testEmailErrorGeneric',
    });
    assert.deepEqual(resolveTestEmailError(new Error('boom')), {
      key: 'admin.testEmailErrorGeneric',
    });
    assert.deepEqual(resolveTestEmailError(undefined), {
      key: 'admin.testEmailErrorGeneric',
    });
  });

  test('is silent for a session-expired error', () => {
    assert.equal(resolveTestEmailError(new SessionExpiredError()), null);
  });
});

describe('formatTestEmailError', () => {
  function makeT(locale: unknown) {
    const resolve = (obj: unknown, path: string): string => {
      let curr = obj;
      for (const p of path.split('.')) {
        curr = (curr as Record<string, unknown>)[p];
      }
      return String(curr);
    };
    return (key: string, params?: Record<string, string | number>): string => {
      let text = resolve(locale, key);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(`{{${k}}}`, String(v));
        }
      }
      return text;
    };
  }

  test('returns null when there is no error to show', () => {
    assert.equal(formatTestEmailError(null, makeT(en)), null);
  });

  test('interpolates the Retry-After seconds into the localized message', () => {
    const msg = resolveTestEmailError({ status: 429, retryAfter: 45 });
    assert.equal(
      formatTestEmailError(msg, makeT(en)),
      'Too many requests. Try again in 45s.',
    );
    assert.equal(
      formatTestEmailError(msg, makeT(zhCN)),
      '请求过于频繁，请在 45 秒后重试。',
    );
  });
});

describe('test email i18n keys', () => {
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
      'admin.sendTestEmail',
      'admin.testEmailRecipient',
      'admin.testEmailNote',
      'admin.testEmailSuccess',
      'admin.testEmailErrorBadRequest',
      'admin.testEmailErrorTooManyRequests',
      'admin.testEmailErrorSendFailed',
      'admin.testEmailErrorGeneric',
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
