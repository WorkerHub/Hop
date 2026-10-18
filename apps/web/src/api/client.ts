// Typed API client with automatic token refresh

let accessToken: string | null = null;

// FE-R2: When a refresh is rejected, every request that was waiting on it sees
// the same failure. Handle the expiry once per session (instead of each request
// hard-navigating to /login) and let the app end the session in-SPA through the
// handler registered by AuthProvider.
let sessionExpiredHandled = false;
let sessionExpiredHandler: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
  // A fresh token starts a new session, so a later expiry is handled again.
  if (token) sessionExpiredHandled = false;
}

export function getAccessToken() {
  return accessToken;
}

export function setSessionExpiredHandler(handler: (() => void) | null) {
  sessionExpiredHandler = handler;
}

function handleSessionExpired() {
  accessToken = null;
  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  if (sessionExpiredHandler) sessionExpiredHandler();
  else {
    // No in-SPA handler registered (should not happen inside AuthProvider):
    // keep the destination so the user returns after signing in again.
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(
      next.startsWith('/login')
        ? '/login'
        : `/login?next=${encodeURIComponent(next)}`,
    );
  }
}

const BASE = '/api';

interface ApiError {
  error: string;
}

// FE-R4: react-query only retries transport failures and server errors. A 4xx
// is the server's final answer (validation, auth, not found); retrying it just
// delays the error the user needs to see.
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

// FE-R4: a transport failure (offline, timeout, DNS) is worth retrying, but it
// is distinct from an HTTP response — otherwise `isRetryableError` cannot tell
// a network problem (retry) from a thrown programming/parse error (don't retry).
export class NetworkError extends Error {
  constructor(message = 'Network error. Please try again.') {
    super(message);
    this.name = 'NetworkError';
  }
}

// #6: the session is over — every request waiting on the same refresh sees this
// error, so the UI layer must not toast once per request. `isSessionExpiredError`
// lets callers skip their own error toast; AuthProvider shows a single one.
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof SessionExpiredError;
}

export function isRetryableError(error: unknown): boolean {
  if (isSessionExpiredError(error)) return false;
  if (error instanceof ApiRequestError) return error.status >= 500;
  // Only the two classified transport paths are retried: a failed fetch and the
  // 'transient' refresh outcome (both thrown as NetworkError). Everything else —
  // a JSON parse failure, a programmer error — is a bug that a retry cannot fix.
  return error instanceof NetworkError;
}

async function request<T>(
  path: string,
  options: RequestInit & { skipAuth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (!options.skipAuth && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  // H4: credentials: 'include' sends the HttpOnly refresh cookie on every request
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });
  } catch {
    throw new NetworkError();
  }

  if (res.status === 401 && !options.skipAuth) {
    // Attempt silent refresh via HttpOnly cookie
    const outcome = await tryRefresh();
    if (outcome === 'ok') {
      headers.Authorization = `Bearer ${accessToken}`;
      let retryRes: Response;
      try {
        retryRes = await fetch(`${BASE}${path}`, {
          ...options,
          headers,
          credentials: 'include',
        });
      } catch {
        throw new NetworkError();
      }
      if (!retryRes.ok) {
        const err = (await retryRes
          .json()
          .catch(() => ({ error: 'Request failed' }))) as ApiError;
        throw new ApiRequestError(err.error, retryRes.status);
      }
      return retryRes.json() as Promise<T>;
    }
    if (outcome === 'transient') {
      // FE-R1: The refresh never got a verdict (offline, 5xx). The refresh
      // cookie may still be valid, so keep the session and fail just this
      // request — react-query retries, and the next 401 refreshes again.
      throw new NetworkError();
    }
    // The server rejected the refresh cookie — the session is really over.
    handleSessionExpired();
    throw new SessionExpiredError();
  }

  if (!res.ok) {
    const err = (await res
      .json()
      .catch(() => ({ error: 'Request failed' }))) as ApiError;
    throw new ApiRequestError(err.error, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// H4: Refresh uses the HttpOnly cookie — no token in body, no localStorage
// S3: In-flight dedup prevents multiple concurrent 401s from each triggering a refresh call.
//     With refresh token rotation, only the first call succeeds; others would see a revoked
//     token and force the user back to login unexpectedly.
// FE-S1: The dedup is additionally serialized across tabs via the Web Locks API, so
//     sibling tabs refreshing from the same cookie wait for each other instead of
//     rotating the refresh token out from under one another.
// FE-R1: 'transient' (network failure, 5xx, 408/429) says nothing about the
// session; only 'expired' — the server rejected the refresh cookie — ends it.
export type RefreshOutcome = 'ok' | 'expired' | 'transient';

let refreshPromise: Promise<RefreshOutcome> | null = null;

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    return locks.request(
      'auth-refresh',
      { mode: 'exclusive' },
      fn,
    ) as Promise<T>;
  }
  return fn();
}

async function tryRefresh(): Promise<RefreshOutcome> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = withRefreshLock(_doRefresh).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function _doRefresh(): Promise<RefreshOutcome> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
  } catch {
    return 'transient';
  }
  if (!res.ok) {
    const transient =
      res.status >= 500 || res.status === 408 || res.status === 429;
    return transient ? 'transient' : 'expired';
  }
  try {
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) return 'transient';
    setAccessToken(data.accessToken);
    return 'ok';
  } catch {
    return 'transient';
  }
}

// Serialized silent refresh for the BroadcastChannel 'refresh' handler and the
// initial session restore. On 'ok' the new access token is already set; callers
// must keep 'transient' distinct from 'expired' (FE-R1).
export function refreshSession(): Promise<RefreshOutcome> {
  return tryRefresh();
}

// ─── Auth API ─────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  username: string;
  role: 'admin' | 'user';
  is_active: boolean;
  totp_enabled: boolean;
  email_2fa_enabled: boolean;
  passkey_enabled: boolean;
  created_at: number;
}

// FE-Q3: SQLite has no boolean type — flag columns come back as 0/1 numbers.
// They are normalized once, at the client boundary, so pages deal in real
// booleans instead of sprinkling `!!x` (one forgotten coercion makes 0 truthy).
type Booleanish = boolean | number | null | undefined;

interface WireUser {
  id: string;
  email: string;
  username: string;
  role: 'admin' | 'user';
  is_active?: Booleanish;
  totp_enabled?: Booleanish;
  email_2fa_enabled?: Booleanish;
  passkey_enabled?: Booleanish;
  created_at?: number;
}

function asBoolean(value: Booleanish): boolean {
  return value === true || value === 1;
}

function normalizeUser(user: WireUser): User {
  // Login and /auth/me return only id/email/username/role, so flag columns are
  // absent there and default to false; the admin user list sends real values.
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    is_active: asBoolean(user.is_active),
    totp_enabled: asBoolean(user.totp_enabled),
    email_2fa_enabled: asBoolean(user.email_2fa_enabled),
    passkey_enabled: asBoolean(user.passkey_enabled),
    created_at: user.created_at ?? 0,
  };
}

export interface LoginResult {
  requiresTwoFactor?: boolean;
  pendingToken?: string;
  methods?: string[];
  accessToken?: string;
  user?: User;
}

interface WireLoginResult extends Omit<LoginResult, 'user'> {
  user?: WireUser;
}

function normalizeLoginResult(result: WireLoginResult): LoginResult {
  const { user, ...rest } = result;
  return user ? { ...rest, user: normalizeUser(user) } : rest;
}

export interface RegisterResult {
  user?: User;
  requiresEmailVerification?: boolean;
  userId?: string;
}

interface WireRegisterResult extends Omit<RegisterResult, 'user'> {
  user?: WireUser;
}

export const authApi = {
  register: (email: string, username: string, password: string) =>
    request<WireRegisterResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, username, password }),
      skipAuth: true,
    }).then((result) => {
      const { user, ...rest } = result;
      return user ? { ...rest, user: normalizeUser(user) } : rest;
    }),

  login: (email: string, password: string) =>
    request<WireLoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipAuth: true,
    }).then(normalizeLoginResult),

  me: () =>
    request<{ user: WireUser }>('/auth/me').then((result) => ({
      user: normalizeUser(result.user),
    })),

  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ success: boolean }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // H4: Refresh token is in the HttpOnly cookie — no parameter needed
  refresh: () =>
    request<{ accessToken: string }>('/auth/refresh', {
      method: 'POST',
      skipAuth: true,
    }),

  // Email verification (registration)
  verifyEmail: (userId: string, code: string) =>
    request<WireLoginResult>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ userId, code }),
      skipAuth: true,
    }).then(normalizeLoginResult),
  resendVerifyEmail: (userId: string) =>
    request<{ success: boolean }>('/auth/resend-verify-email', {
      method: 'POST',
      body: JSON.stringify({ userId }),
      skipAuth: true,
    }),

  // Forgot / Reset Password
  forgotPassword: (email: string) =>
    request<{ success: boolean }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
      skipAuth: true,
    }),
  verifyResetCode: (email: string, code: string) =>
    request<{ success: boolean }>('/auth/verify-reset-code', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
      skipAuth: true,
    }),
  resetPassword: (email: string, code: string, newPassword: string) =>
    request<{ success: boolean }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email, code, newPassword }),
      skipAuth: true,
    }),

  // TOTP
  totpSetup: () =>
    request<{ secret: string; uri: string }>('/auth/2fa/totp/setup'),
  totpConfirm: (code: string) =>
    request<{ success: boolean; backupCodes: string[] }>(
      '/auth/2fa/totp/confirm',
      {
        method: 'POST',
        body: JSON.stringify({ code }),
      },
    ),
  totpDisable: (currentPassword: string) =>
    request<{ success: boolean }>('/auth/2fa/totp', {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword }),
    }),
  totpVerify: (pendingToken: string, code: string) =>
    request<WireLoginResult>('/auth/2fa/totp/verify', {
      method: 'POST',
      body: JSON.stringify({ pendingToken, code }),
      skipAuth: true,
    }).then(normalizeLoginResult),

  // Email OTP
  emailOtpSendVerify: () =>
    request<{ success: boolean }>('/auth/2fa/email-otp/send-verify', {
      method: 'POST',
    }),
  emailOtpEnable: (code: string) =>
    request<{ success: boolean }>('/auth/2fa/email-otp/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  emailOtpDisable: (currentPassword: string) =>
    request<{ success: boolean }>('/auth/2fa/email-otp', {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword }),
    }),
  emailOtpSend: (pendingToken: string) =>
    request<{ success: boolean }>('/auth/2fa/email-otp/send', {
      method: 'POST',
      body: JSON.stringify({ pendingToken }),
      skipAuth: true,
    }),
  emailOtpVerify: (pendingToken: string, code: string) =>
    request<WireLoginResult>('/auth/2fa/email-otp/verify', {
      method: 'POST',
      body: JSON.stringify({ pendingToken, code }),
      skipAuth: true,
    }).then(normalizeLoginResult),

  // Passkey
  passkeyList: () =>
    request<{
      passkeys: Array<{
        id: string;
        name: string | null;
        created_at: number;
        last_used_at: number | null;
      }>;
    }>('/auth/2fa/passkey'),
  passkeyRegisterOptions: () =>
    request<{
      options: PublicKeyCredentialCreationOptionsJSON;
      challengeId: string;
    }>('/auth/2fa/passkey/register-options', { method: 'POST' }),
  passkeyRegisterVerify: (
    response: RegistrationResponseJSON,
    challengeId: string,
    name?: string,
  ) =>
    request<{ success: boolean; credentialId: string }>(
      '/auth/2fa/passkey/register-verify',
      {
        method: 'POST',
        body: JSON.stringify({ response, challengeId, name }),
      },
    ),
  // H-3: Backend requires currentPassword to remove a passkey (M1 password confirmation)
  passkeyDelete: (id: string, currentPassword: string) =>
    request<{ success: boolean }>(`/auth/2fa/passkey/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword }),
    }),
  passkeyVerifyOptions: (pendingToken: string) =>
    request<{
      options: PublicKeyCredentialRequestOptionsJSON;
      challengeId: string;
    }>('/auth/2fa/passkey/verify-options', {
      method: 'POST',
      body: JSON.stringify({ pendingToken }),
      skipAuth: true,
    }),
  passkeyVerify: (
    pendingToken: string,
    response: AuthenticationResponseJSON,
    challengeId: string,
  ) =>
    request<WireLoginResult>('/auth/2fa/passkey/verify', {
      method: 'POST',
      body: JSON.stringify({ pendingToken, response, challengeId }),
      skipAuth: true,
    }).then(normalizeLoginResult),
};

// ─── Links API ────────────────────────────────────────────────────────────────

export interface Link {
  id: string;
  slug: string;
  destination_url: string;
  title: string | null;
  expires_at: number | null;
  is_active: boolean;
  user_seq: number;
  created_at: number;
  updated_at?: number;
  click_count?: number;
}

// FE-Q3: wire shape of a link — `is_active` arrives as SQLite's 0/1.
interface WireLink {
  id: string;
  slug: string;
  destination_url: string;
  title: string | null;
  expires_at: number | null;
  is_active?: Booleanish;
  user_seq: number;
  created_at: number;
  updated_at?: number;
  click_count?: number;
}

// Generic over extra columns (admin links carry seq/user_email) so the
// normalized result keeps them.
function normalizeLink<T extends WireLink>(
  link: T,
): Omit<T, 'is_active'> & { is_active: boolean } {
  return { ...link, is_active: asBoolean(link.is_active) };
}

export interface CreateLinkPayload {
  destinationUrl: string;
  customSlug?: string;
  title?: string;
  expiryDays?: number | null;
  expiresAt?: number | null;
}

export const linksApi = {
  list: (params?: { page?: number; limit?: number; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.search) qs.set('search', params.search);
    return request<{
      links: WireLink[];
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(`/links?${qs}`).then((result) => ({
      ...result,
      links: result.links.map(normalizeLink),
    }));
  },
  get: (id: string) =>
    request<{ link: WireLink }>(`/links/${id}`).then((result) => ({
      link: normalizeLink(result.link),
    })),
  create: (payload: CreateLinkPayload) =>
    request<{ link: WireLink }>('/links', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then((result) => ({ link: normalizeLink(result.link) })),
  update: (
    id: string,
    payload: Partial<CreateLinkPayload & { isActive: boolean }>,
  ) =>
    request<{ link: WireLink }>(`/links/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }).then((result) => ({ link: normalizeLink(result.link) })),
  delete: (id: string) =>
    request<{ success: boolean }>(`/links/${id}`, { method: 'DELETE' }),
};

// ─── Analytics API ────────────────────────────────────────────────────────────

export interface AnalyticsStats {
  totalClicks: number;
  days: number;
  timeline: Array<{ day: string; clicks: number }>;
  countries: Array<{ country: string; clicks: number }>;
  devices: Array<{ device_type: string; clicks: number }>;
  browsers: Array<{ browser: string; clicks: number }>;
  os: Array<{ os: string; clicks: number }>;
  referrers: Array<{ referer: string; clicks: number }>;
  topLinks?: Array<{
    id: string;
    slug: string;
    title: string | null;
    clicks: number;
  }>;
}

export const analyticsApi = {
  summary: (days = 30) =>
    request<{ stats: AnalyticsStats }>(`/analytics/summary?days=${days}`),

  get: (linkId: string, days = 30) =>
    request<{
      link: {
        id: string;
        slug: string;
        destinationUrl: string;
        title: string | null;
        createdAt: number;
        expiresAt: number | null;
      };
      stats: AnalyticsStats;
    }>(`/analytics/${linkId}?days=${days}`),
};

// ─── Admin API ────────────────────────────────────────────────────────────────

export const adminApi = {
  stats: () =>
    request<{
      users: number;
      links: number;
      clicksToday: number;
      clicksTotal: number;
    }>('/admin/stats'),
  users: (params?: { page?: number; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.search) qs.set('search', params.search);
    return request<{
      users: WireUser[];
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(`/admin/users?${qs}`).then((result) => ({
      ...result,
      users: result.users.map(normalizeUser),
    }));
  },
  updateUser: (
    id: string,
    payload: { isActive?: boolean; role?: 'admin' | 'user' },
  ) =>
    request<{ success: boolean }>(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteUser: (id: string) =>
    request<{ success: boolean }>(`/admin/users/${id}`, { method: 'DELETE' }),
  links: (params?: { page?: number; search?: string; userId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.search) qs.set('search', params.search);
    if (params?.userId) qs.set('userId', params.userId);
    return request<{
      links: Array<
        WireLink & { seq: number; user_email: string; user_username: string }
      >;
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(`/admin/links?${qs}`).then((result) => ({
      ...result,
      links: result.links.map(normalizeLink),
    }));
  },
  createUser: (payload: {
    email: string;
    username: string;
    password: string;
    role?: 'admin' | 'user';
  }) =>
    request<{ user: WireUser }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then((result) => ({ user: normalizeUser(result.user) })),
  getSettings: () =>
    request<{ settings: Record<string, string> }>('/admin/settings'),
  updateSettings: (settings: Record<string, string>) =>
    request<{ success: boolean }>('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
};

// Re-export WebAuthn types used by auth API
type PublicKeyCredentialCreationOptionsJSON =
  import('@simplewebauthn/browser').PublicKeyCredentialCreationOptionsJSON;
type PublicKeyCredentialRequestOptionsJSON =
  import('@simplewebauthn/browser').PublicKeyCredentialRequestOptionsJSON;
type RegistrationResponseJSON =
  import('@simplewebauthn/browser').RegistrationResponseJSON;
type AuthenticationResponseJSON =
  import('@simplewebauthn/browser').AuthenticationResponseJSON;
