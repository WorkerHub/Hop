import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  ApiRequestError,
  authApi,
  getAccessToken,
  isRetryableError,
  isSessionExpiredError,
  linksApi,
  refreshSession,
  SessionExpiredError,
  setAccessToken,
  setSessionExpiredHandler,
} from './client.ts';

// BE-Q2 (frontend half): the refresh path has three outcomes — ok, expired and
// transient — plus cross-tab serialization and in-flight dedup. These tests pin
// that behaviour down with a stubbed fetch, no extra dependencies.

const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  'navigator',
);

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function headerValue(
  init: RequestInit | undefined,
  name: string,
): string | null {
  return new Headers(init?.headers as HeadersInit | undefined).get(name);
}

beforeEach(() => {
  // `sessionExpiredHandled` is sticky for a session; a fresh token resets it.
  setAccessToken('test-reset');
  setAccessToken(null);
  setSessionExpiredHandler(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  }
});

describe('refreshSession outcomes', () => {
  test('ok stores the new access token', async () => {
    mockFetch((url) => {
      assert.match(url, /\/auth\/refresh$/);
      return jsonResponse({ accessToken: 'token-1' });
    });

    assert.equal(await refreshSession(), 'ok');
    assert.equal(getAccessToken(), 'token-1');
  });

  test('a rejected refresh cookie is expired', async () => {
    mockFetch(() => jsonResponse({ error: 'Invalid refresh token' }, 401));

    assert.equal(await refreshSession(), 'expired');
    assert.equal(getAccessToken(), null);
  });

  test('a transport failure is transient, not expired', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    assert.equal(await refreshSession(), 'transient');
  });

  test('5xx, 408 and 429 are transient', async () => {
    for (const status of [500, 502, 503, 408, 429]) {
      mockFetch(() => jsonResponse({ error: 'later' }, status));
      assert.equal(await refreshSession(), 'transient', `status ${status}`);
    }
  });

  test('a 200 without an access token is transient', async () => {
    mockFetch(() => jsonResponse({}));

    assert.equal(await refreshSession(), 'transient');
  });
});

describe('refresh concurrency', () => {
  test('concurrent callers share one refresh request', async () => {
    let release: ((response: Response) => void) | undefined;
    const calls = mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    const first = refreshSession();
    const second = refreshSession();
    await Promise.resolve();
    assert.ok(release);
    release(jsonResponse({ accessToken: 'shared-token' }));

    assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
    assert.equal(calls.length, 1);
  });

  test('the refresh is serialized through the Web Locks API', async () => {
    const requested: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (
            name: string,
            _options: unknown,
            callback: () => Promise<unknown>,
          ) => {
            requested.push(name);
            return callback();
          },
        },
      },
    });
    mockFetch(() => jsonResponse({ accessToken: 'locked-token' }));

    assert.equal(await refreshSession(), 'ok');
    assert.deepEqual(requested, ['auth-refresh']);
    assert.equal(getAccessToken(), 'locked-token');
  });

  test('falls back to a direct call when Web Locks is unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
    const calls = mockFetch(() => jsonResponse({ accessToken: 'plain-token' }));

    assert.equal(await refreshSession(), 'ok');
    assert.equal(calls.length, 1);
  });
});

describe('request() after a 401', () => {
  test('retries once with the refreshed token and normalizes booleans', async () => {
    const calls = mockFetch((url, init) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({ accessToken: 'fresh-token' });
      }
      assert.match(url, /\/auth\/me$/);
      if (headerValue(init, 'authorization') === 'Bearer fresh-token') {
        return jsonResponse({
          user: {
            id: 'u1',
            email: 'a@example.com',
            username: 'alice',
            role: 'user',
            is_active: 1,
            totp_enabled: 0,
            email_2fa_enabled: 1,
            passkey_enabled: 0,
            created_at: 1,
          },
        });
      }
      return jsonResponse({ error: 'Unauthorized' }, 401);
    });
    setAccessToken('stale-token');

    const { user } = await authApi.me();

    assert.equal(user.is_active, true);
    assert.equal(user.totp_enabled, false);
    assert.equal(user.email_2fa_enabled, true);
    assert.equal(user.passkey_enabled, false);
    assert.equal(calls.length, 3);
  });

  test('reports an expired session once across concurrent requests', async () => {
    let handled = 0;
    setAccessToken('stale-token');
    setSessionExpiredHandler(() => {
      handled += 1;
    });
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({ error: 'Invalid refresh token' }, 401);
      }
      return jsonResponse({ error: 'Unauthorized' }, 401);
    });

    const results = await Promise.allSettled([authApi.me(), authApi.me()]);

    assert.equal(handled, 1);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.ok(isSessionExpiredError(result.reason));
      }
    }
  });

  test('a 4xx other than 401 is final and keeps its status', async () => {
    const calls = mockFetch(() =>
      jsonResponse({ error: 'Validation failed' }, 400),
    );
    setAccessToken('token');

    await assert.rejects(authApi.me(), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 400);
      assert.equal(error.message, 'Validation failed');
      return true;
    });
    assert.equal(calls.length, 1);
  });
});

describe('link boolean normalization (FE-Q3)', () => {
  test('list() turns SQLite 0/1 into booleans', async () => {
    setAccessToken('token');
    mockFetch(() =>
      jsonResponse({
        links: [
          {
            id: 'l1',
            slug: 'one',
            destination_url: 'https://example.com',
            title: null,
            expires_at: null,
            is_active: 1,
            user_seq: 1,
            created_at: 1,
          },
          {
            id: 'l2',
            slug: 'two',
            destination_url: 'https://example.com',
            title: null,
            expires_at: null,
            is_active: 0,
            user_seq: 2,
            created_at: 1,
          },
        ],
        pagination: { page: 1, limit: 20, total: 2, pages: 1 },
      }),
    );

    const { links } = await linksApi.list();

    assert.equal(links[0]?.is_active, true);
    assert.equal(links[1]?.is_active, false);
  });
});

describe('isRetryableError (FE-R4)', () => {
  test('retries transport errors and 5xx only', () => {
    assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
    assert.equal(isRetryableError(new ApiRequestError('boom', 500)), true);
    assert.equal(isRetryableError(new ApiRequestError('nope', 400)), false);
    assert.equal(isRetryableError(new ApiRequestError('nope', 404)), false);
    assert.equal(isRetryableError(new ApiRequestError('expired', 401)), false);
  });

  test('never retries an expired session', () => {
    assert.equal(isRetryableError(new SessionExpiredError()), false);
  });
});
