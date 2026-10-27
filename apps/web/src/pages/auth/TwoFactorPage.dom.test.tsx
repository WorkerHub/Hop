/**
 * ONE-579 regression test — the 2FA completion must not bounce back to /login.
 *
 * The bug lived entirely in the browser: `handleSuccess` called
 * `navigate('/dashboard')` and then `clearPendingState()`. BrowserRouter commits
 * route state inside `React.startTransition` (a non-urgent lane) while the
 * pending-state reset is an urgent update, so the page re-rendered without a
 * pendingToken while `location` was still /two-factor; its
 * `<Navigate to="/login">` guard then replaced the fresh /dashboard entry ~1ms
 * later. No request ever failed, which is why the `node --test` suite (pure
 * modules, no DOM) could not see it.
 *
 * This suite renders the real TwoFactorPage inside a real MemoryRouter — which,
 * like BrowserRouter, runs route updates through `React.startTransition`
 * (react-router's `useTransitions` default) — with only the transport (`fetch`)
 * and the WebAuthn ceremony stubbed.
 *
 * Coverage (all three assertions fail if the latch is removed — they end up on
 * /login, which is the reported symptom):
 *  1. the latch itself: losing the pendingToken after it was held must not
 *     render the /login guard;
 *  2. end to end for both verification branches (TOTP / Passkey): the final
 *     location is /dashboard and /login is never rendered;
 *  3. the guard still works: opening the page without ever holding a token
 *     redirects to /login.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { I18nProvider } from '@/i18n';
import TwoFactorPage from './TwoFactorPage';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The WebAuthn ceremony needs a real authenticator; what is under test is the
// code that runs after `passkey/verify` answers, so its result is canned.
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({
    id: 'cred-1',
    rawId: 'cred-1',
    response: {},
    type: 'public-key',
    clientExtensionResults: {},
  })),
}));

const USER = {
  id: 'u1',
  email: 'owner@example.com',
  username: 'owner',
  role: 'admin' as const,
  is_active: true,
  totp_enabled: true,
  email_2fa_enabled: false,
  passkey_enabled: true,
  created_at: 0,
};

/** Every pathname the router rendered, in order. */
let pathLog: string[] = [];
let container: HTMLDivElement;
let root: Root;

/** AuthContext handles, seeded from inside the provider (see `Seeder`). */
let seedPendingState: ((token: string, methods: string[]) => void) | null =
  null;
let clearPendingState: (() => void) | null = null;

function LocationProbe() {
  pathLog.push(useLocation().pathname);
  return null;
}

// The app mounts this page only after the login step put a pendingToken into
// AuthContext, so the harness does the same: it renders nothing until a token
// exists and only then mounts the routes (a token-less mount would legitimately
// redirect to /login and pollute the assertions). Once mounted it stays mounted,
// which is what lets the /login guard become visible at all.
function Harness({ mountImmediately = false }: { mountImmediately?: boolean }) {
  const { pendingToken } = useAuth();
  const mountedOnce = useRef(false);
  if (mountImmediately || pendingToken) mountedOnce.current = true;
  if (!mountedOnce.current) return null;

  return (
    <Routes>
      <Route path="/two-factor" element={<TwoFactorPage />} />
      <Route path="/login" element={<div>login page</div>} />
      <Route path="/dashboard" element={<div>dashboard page</div>} />
    </Routes>
  );
}

// Reaches the pending-state API of the real AuthProvider from inside it, so the
// test can reproduce the handoff from LoginPage without re-running the password
// step.
function Seeder() {
  const auth = useAuth();
  seedPendingState = auth.setPendingState;
  clearPendingState = auth.clearPendingState;
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Minimal transport stub. The first paint has no refresh cookie (the real one
 * answers 401); every call after a successful verify succeeds.
 */
function stubFetch(verifyPath: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/refresh')) {
      return json({ error: 'unauthorized' }, 401);
    }
    if (url.endsWith('/auth/me')) return json({ user: USER });
    if (url.endsWith(verifyPath)) {
      return json({ accessToken: 'access-token', user: USER });
    }
    if (url.endsWith('/auth/2fa/passkey/verify-options')) {
      return json({ options: { challenge: 'c' }, challengeId: 'ch-1' });
    }
    return json({ error: 'not stubbed' }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Flush microtasks, timers and the transition render that carries navigation. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountTwoFactorPage({
  methods = ['totp'],
  seed = true,
  mountImmediately = false,
}: {
  methods?: string[];
  seed?: boolean;
  mountImmediately?: boolean;
} = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <I18nProvider>
          <MemoryRouter initialEntries={['/two-factor']}>
            <AuthProvider>
              <Seeder />
              <LocationProbe />
              <Harness mountImmediately={mountImmediately} />
            </AuthProvider>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();

  if (!seed) return;

  expect(
    seedPendingState,
    'AuthProvider should expose setPendingState',
  ).toBeTypeOf('function');
  await act(async () => {
    seedPendingState?.('pending-token', methods);
  });
  await settle();
}

async function submitTotpCode(code: string) {
  const input = container.querySelector('#totp-code') as HTMLInputElement;
  expect(input, 'the TOTP form should be rendered').not.toBeNull();
  await act(async () => {
    setInputValue(input, code);
  });
  const form = container.querySelector('form') as HTMLFormElement;
  await act(async () => {
    form.requestSubmit();
  });
  await settle();
}

async function clickPasskeyVerify() {
  const button = container.querySelector('button') as HTMLButtonElement;
  expect(button, 'the passkey button should be rendered').not.toBeNull();
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  pathLog = [];
  seedPendingState = null;
  clearPendingState = null;
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TwoFactorPage — ONE-579 landing after a successful verification', () => {
  it('does not render the /login guard once the pending token is gone', async () => {
    stubFetch('/auth/2fa/totp/verify');
    await mountTwoFactorPage({ methods: ['totp'] });

    expect(container.querySelector('#totp-code')).not.toBeNull();

    // This is the urgent update that raced the /dashboard transition: it lands
    // while the router still says /two-factor. Without the latch the guard
    // fires here and sends the (already signed-in) user to /login.
    await act(async () => {
      clearPendingState?.();
    });
    await settle();

    expect(pathLog.at(-1)).toBe('/two-factor');
    expect(pathLog).not.toContain('/login');
  });

  it('still redirects to /login when opened without ever holding a token', async () => {
    stubFetch('/auth/2fa/totp/verify');
    await mountTwoFactorPage({ seed: false, mountImmediately: true });

    expect(pathLog.at(-1)).toBe('/login');
  });

  it('TOTP: lands on /dashboard and never renders /login', async () => {
    stubFetch('/auth/2fa/totp/verify');
    await mountTwoFactorPage({ methods: ['totp'] });
    await submitTotpCode('123456');

    expect(pathLog.at(-1)).toBe('/dashboard');
    expect(pathLog).not.toContain('/login');
  });

  it('Passkey: lands on /dashboard and never renders /login', async () => {
    stubFetch('/auth/2fa/passkey/verify');
    await mountTwoFactorPage({ methods: ['passkey'] });
    await clickPasskeyVerify();

    expect(pathLog.at(-1)).toBe('/dashboard');
    expect(pathLog).not.toContain('/login');
  });
});
