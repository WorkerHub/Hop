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
  else window.location.assign('/login');
}

const BASE = '/api';

interface ApiError {
  error: string;
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
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && !options.skipAuth) {
    // Attempt silent refresh via HttpOnly cookie
    const outcome = await tryRefresh();
    if (outcome === 'ok') {
      headers.Authorization = `Bearer ${accessToken}`;
      const retryRes = await fetch(`${BASE}${path}`, {
        ...options,
        headers,
        credentials: 'include',
      });
      if (!retryRes.ok) {
        const err = (await retryRes
          .json()
          .catch(() => ({ error: 'Request failed' }))) as ApiError;
        throw new Error(err.error);
      }
      return retryRes.json() as Promise<T>;
    }
    if (outcome === 'transient') {
      // FE-R1: The refresh never got a verdict (offline, 5xx). The refresh
      // cookie may still be valid, so keep the session and fail just this
      // request — react-query retries, and the next 401 refreshes again.
      throw new Error('Network error. Please try again.');
    }
    // The server rejected the refresh cookie — the session is really over.
    handleSessionExpired();
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const err = (await res
      .json()
      .catch(() => ({ error: 'Request failed' }))) as ApiError;
    throw new Error(err.error);
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
type RefreshOutcome = 'ok' | 'expired' | 'transient';

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
// initial session restore — returns the new access token, or null when there is
// no valid session.
export async function refreshSession(): Promise<string | null> {
  const outcome = await tryRefresh();
  return outcome === 'ok' ? getAccessToken() : null;
}

// ─── Auth API ─────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  username: string;
  role: 'admin' | 'user';
  is_active: number;
  totp_enabled: number;
  email_2fa_enabled: number;
  passkey_enabled: number;
  created_at: number;
}

export interface LoginResult {
  requiresTwoFactor?: boolean;
  pendingToken?: string;
  methods?: string[];
  accessToken?: string;
  user?: User;
}

export interface RegisterResult {
  user?: User;
  requiresEmailVerification?: boolean;
  userId?: string;
}

export const authApi = {
  register: (email: string, username: string, password: string) =>
    request<RegisterResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, username, password }),
      skipAuth: true,
    }),

  login: (email: string, password: string) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipAuth: true,
    }),

  me: () => request<{ user: User }>('/auth/me'),

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
    request<LoginResult>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ userId, code }),
      skipAuth: true,
    }),
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
    request<LoginResult>('/auth/2fa/totp/verify', {
      method: 'POST',
      body: JSON.stringify({ pendingToken, code }),
      skipAuth: true,
    }),

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
    request<LoginResult>('/auth/2fa/email-otp/verify', {
      method: 'POST',
      body: JSON.stringify({ pendingToken, code }),
      skipAuth: true,
    }),

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
    request<LoginResult>('/auth/2fa/passkey/verify', {
      method: 'POST',
      body: JSON.stringify({ pendingToken, response, challengeId }),
      skipAuth: true,
    }),
};

// ─── Links API ────────────────────────────────────────────────────────────────

export interface Link {
  id: string;
  slug: string;
  destination_url: string;
  title: string | null;
  expires_at: number | null;
  is_active: number;
  user_seq: number;
  created_at: number;
  updated_at?: number;
  click_count?: number;
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
      links: Link[];
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(`/links?${qs}`);
  },
  get: (id: string) => request<{ link: Link }>(`/links/${id}`),
  create: (payload: CreateLinkPayload) =>
    request<{ link: Link }>('/links', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  update: (
    id: string,
    payload: Partial<CreateLinkPayload & { isActive: boolean }>,
  ) =>
    request<{ link: Link }>(`/links/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
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
      users: User[];
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(`/admin/users?${qs}`);
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
        Link & { seq: number; user_email: string; user_username: string }
      >;
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(`/admin/links?${qs}`);
  },
  createUser: (payload: {
    email: string;
    username: string;
    password: string;
    role?: 'admin' | 'user';
  }) =>
    request<{ user: User }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
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
