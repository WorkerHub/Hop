import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  generateOtp,
  hashPassword,
  sha256,
  verifyPassword,
} from '../lib/crypto.js';
import { isUniqueConstraintError, tbl } from '../lib/db.js';
import {
  otpEmailHtml,
  resetPasswordEmailHtml,
  sendEmail,
  verifyEmailHtml,
} from '../lib/email.js';
import { apiError } from '../lib/errors.js';
import {
  signAccessToken,
  signPendingToken,
  signRefreshToken,
  verifyPendingToken,
  verifyRefreshToken,
} from '../lib/jwt.js';
import {
  checkForgotPasswordIpRateLimit,
  checkLoginRateLimit,
  checkOtpRateLimit,
  checkRegisterRateLimit,
  deletePending2fa,
  denylistJti,
  getAndDeletePasskeyChallenge,
  getCachedSetting,
  getPending2fa,
  increment2faAttempts,
  incrementPasskeyOptsAttempts,
  incrementTotpConfirmAttempts,
  isJtiDenylisted,
  resetLoginAttempts,
  resetTotpConfirmAttempts,
  setCachedSetting,
  setPasskeyChallenge,
  setPending2fa,
} from '../lib/kv.js';
import {
  buildTotpUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBackupCodes,
  generateTotpSecret,
  verifyTotp,
} from '../lib/totp.js';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  uint8ArrayToBase64Url,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from '../lib/webauthn.js';
import { requireAuth } from '../middleware/auth.js';
import type { Env, PasskeyRow, UserRow, Variables } from '../types.js';

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

type AuthContext = Context<{ Bindings: Env; Variables: Variables }>;

// ─── Cookie helpers (H4: HttpOnly refresh token) ──────────────────────────────

function setRefreshCookie(c: AuthContext, refreshToken: string): void {
  const isSecure = c.env.APP_URL.startsWith('https');
  c.header(
    'Set-Cookie',
    `refreshToken=${refreshToken}; HttpOnly; SameSite=Strict; Max-Age=604800; Path=/api/auth${isSecure ? '; Secure' : ''}`,
  );
}

function clearRefreshCookie(c: AuthContext): void {
  const isSecure = c.env.APP_URL.startsWith('https');
  c.header(
    'Set-Cookie',
    `refreshToken=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/api/auth${isSecure ? '; Secure' : ''}`,
  );
}

function getRefreshCookie(c: AuthContext): string | null {
  const cookie = c.req.header('Cookie') ?? '';
  const match = /(?:^|;\s*)refreshToken=([^;]+)/.exec(cookie);
  return match?.[1] ?? null;
}

// ─── Helper: issue token pair ─────────────────────────────────────────────────

async function issueTokens(user: UserRow, jwtSecret: string) {
  const { token: accessToken } = await signAccessToken(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
      tv: user.token_version,
    },
    jwtSecret,
  );
  const { token: refreshToken } = await signRefreshToken(
    user.id,
    user.token_version,
    jwtSecret,
  );
  return { accessToken, refreshToken };
}

// Client IP from Cloudflare's verified header (cannot be forged by the client).
function clientIp(c: AuthContext): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

// ─── Helper: get registration enabled ────────────────────────────────────────

async function isRegistrationEnabled(env: Env): Promise<boolean> {
  const cached = await getCachedSetting(env.LINKS_KV, 'registration_enabled');
  if (cached !== null) return cached === 'true';
  const row = await env.DB.prepare(
    `SELECT value FROM ${tbl(env, 'settings')} WHERE key = 'registration_enabled'`,
  ).first<{ value: string }>();
  const val = row?.value ?? 'false';
  await setCachedSetting(env.LINKS_KV, 'registration_enabled', val);
  return val === 'true';
}

async function isEmailVerificationRequired(env: Env): Promise<boolean> {
  const cached = await getCachedSetting(
    env.LINKS_KV,
    'require_email_verification',
  );
  if (cached !== null) return cached === 'true';
  const row = await env.DB.prepare(
    `SELECT value FROM ${tbl(env, 'settings')} WHERE key = 'require_email_verification'`,
  ).first<{ value: string }>();
  const val = row?.value ?? 'false';
  await setCachedSetting(env.LINKS_KV, 'require_email_verification', val);
  return val === 'true';
}

// LOW-3: Read app_name from DB/KV so admin settings changes take effect immediately.
async function getAppName(env: Env): Promise<string> {
  const cached = await getCachedSetting(env.LINKS_KV, 'app_name');
  if (cached !== null) return cached;
  const row = await env.DB.prepare(
    `SELECT value FROM ${tbl(env, 'settings')} WHERE key = 'app_name'`,
  ).first<{ value: string }>();
  const val = row?.value ?? env.APP_NAME;
  await setCachedSetting(env.LINKS_KV, 'app_name', val);
  return val;
}

// S4: Dummy hash for constant-time login response when user is not found.
// verifyPassword runs full PBKDF2 against this, normalising response time.
const TIMING_DUMMY_HASH =
  'v1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// ─── Helper: get user 2fa methods ─────────────────────────────────────────────

function getUserMethods(user: UserRow): string[] {
  const methods: string[] = [];
  if (user.totp_enabled) methods.push('totp');
  if (user.passkey_enabled) methods.push('passkey');
  if (user.email_2fa_enabled) methods.push('email_otp');
  return methods;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────
auth.post('/register', async (c) => {
  const body = await c.req
    .json<{ email: string; username: string; password: string }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');

  if (!body.email || !body.username || !body.password) {
    return apiError(
      c,
      400,
      'EMAIL_USERNAME_PASSWORD_REQUIRED',
      'email, username, and password are required',
    );
  }

  const email = body.email.trim().toLowerCase();
  const username = body.username.trim();
  const password = body.password;

  // BE-S6: IP rate limit for registration (10/hour) — bulk account creation guard
  const registerAllowed = await checkRegisterRateLimit(
    c.env.LINKS_KV,
    clientIp(c),
  );
  if (!registerAllowed) {
    return apiError(
      c,
      429,
      'TOO_MANY_REQUESTS',
      'Too many requests. Try again later.',
    );
  }

  // M4: Input validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return apiError(c, 400, 'INVALID_EMAIL', 'Invalid email address');
  }
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return apiError(
      c,
      400,
      'INVALID_USERNAME',
      'Username must be 3–32 characters: letters, numbers, dashes, or underscores',
    );
  }
  if (password.length < 8) {
    return apiError(
      c,
      400,
      'PASSWORD_TOO_SHORT',
      'Password must be at least 8 characters',
    );
  }
  if (password.length > 256) {
    return apiError(c, 400, 'PASSWORD_TOO_LONG', 'Password too long');
  }

  // H3: Check registration status before INSERT
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM ${tbl(c.env, 'users')}`,
  ).first<{ n: number }>();
  const isFirstUser = (countRow?.n ?? 0) === 0;

  if (!isFirstUser) {
    const enabled = await isRegistrationEnabled(c.env);
    if (!enabled) {
      return apiError(
        c,
        403,
        'REGISTRATION_DISABLED',
        'Registration is currently disabled',
      );
    }
  }

  // Check uniqueness
  const existing = await c.env.DB.prepare(
    `SELECT id FROM ${tbl(c.env, 'users')} WHERE email = ?1 OR username = ?2`,
  )
    .bind(email, username)
    .first();
  if (existing) {
    return apiError(
      c,
      409,
      'EMAIL_OR_USERNAME_TAKEN',
      'Email or username already taken',
    );
  }

  const passwordHash = await hashPassword(password);

  // BE-C3: The SELECT above is only a fast path — a concurrent registration with
  // the same email/username can slip between it and the INSERT. The UNIQUE
  // constraints are the real guard; report their violation as 409, not 500.
  type NewUser = { id: string; email: string; username: string; role: string };
  const insertUser = async (sql: string): Promise<NewUser | null | 'taken'> => {
    try {
      return await c.env.DB.prepare(sql)
        .bind(email, username, passwordHash)
        .first<NewUser>();
    } catch (err) {
      if (isUniqueConstraintError(err)) return 'taken';
      throw err;
    }
  };

  // If email verification is required (non-first user only), create account as inactive
  // and send a verification code before the user can log in.
  if (!isFirstUser && (await isEmailVerificationRequired(c.env))) {
    const newUser = await insertUser(
      `INSERT INTO ${tbl(c.env, 'users')} (email, username, password_hash, role, is_active)
       VALUES (?1, ?2, ?3, 'user', 0)
       RETURNING id, email, username, role`,
    );

    if (newUser === 'taken') {
      return apiError(
        c,
        409,
        'EMAIL_OR_USERNAME_TAKEN',
        'Email or username already taken',
      );
    }
    if (!newUser)
      return apiError(c, 500, 'FAILED_TO_CREATE_USER', 'Failed to create user');

    const code = generateOtp(6);
    const codeHash = await sha256(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const appName = await getAppName(c.env);

    try {
      await sendEmail(c.env, {
        to: email,
        subject: `${appName} — Verify your email`,
        html: verifyEmailHtml(appName, code),
      });
    } catch {
      // Roll back the user insert. No verification row exists yet (it's inserted
      // below only on email success), so no additional cleanup is needed.
      await c.env.DB.prepare(`DELETE FROM ${tbl(c.env, 'users')} WHERE id = ?1`)
        .bind(newUser.id)
        .run();
      return apiError(
        c,
        500,
        'EMAIL_SEND_FAILED',
        'Failed to send verification email. Please try again.',
      );
    }

    // BE-C4: delete any previous unused code for this identifier before storing
    // the new one, so a user always has at most one pending code of each type.
    await c.env.DB.prepare(
      `DELETE FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_verify' AND used = 0`,
    )
      .bind(newUser.id)
      .run();

    await c.env.DB.prepare(
      `INSERT INTO ${tbl(c.env, 'verifications')} (identifier, type, code_hash, expires_at) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(newUser.id, 'email_verify', codeHash, expiresAt)
      .run();

    return c.json({ requiresEmailVerification: true, userId: newUser.id }, 201);
  }

  // H3: Role assigned atomically inside SQL — prevents bootstrap race condition
  const result = await insertUser(
    `INSERT INTO ${tbl(c.env, 'users')} (email, username, password_hash, role)
     VALUES (?1, ?2, ?3, CASE WHEN (SELECT COUNT(*) FROM ${tbl(c.env, 'users')}) = 0 THEN 'admin' ELSE 'user' END)
     RETURNING id, email, username, role`,
  );

  if (result === 'taken') {
    return apiError(
      c,
      409,
      'EMAIL_OR_USERNAME_TAKEN',
      'Email or username already taken',
    );
  }
  if (!result)
    return apiError(c, 500, 'FAILED_TO_CREATE_USER', 'Failed to create user');

  return c.json(
    {
      user: {
        id: result.id,
        email: result.email,
        username: result.username,
        role: result.role,
      },
    },
    201,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-email
// ─────────────────────────────────────────────────────────────────────────────
auth.post('/verify-email', async (c) => {
  const body = await c.req
    .json<{ userId: string; code: string }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  if (!body.userId || !body.code || body.code.length > 6) {
    return apiError(
      c,
      400,
      'USER_ID_AND_CODE_REQUIRED',
      'userId and code required',
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(body.userId)
    .first<UserRow>();

  if (!user || user.is_active) {
    return apiError(
      c,
      400,
      'INVALID_OR_EXPIRED_VERIFICATION',
      'Invalid or expired verification',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_verify' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(body.userId, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification) {
    return apiError(
      c,
      400,
      'INVALID_OR_EXPIRED_VERIFICATION_CODE',
      'Invalid or expired verification code',
    );
  }

  if (verification.attempts >= 3) {
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Please request a new code.',
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return apiError(c, 401, 'INVALID_CODE', 'Invalid code');
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'users')} SET is_active = 1, updated_at = unixepoch() WHERE id = ?1`,
    ).bind(body.userId),
    c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET used = 1 WHERE id = ?1`,
    ).bind(verification.id),
  ]);

  const tokens = await issueTokens(user, c.env.JWT_SECRET);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({
    accessToken: tokens.accessToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/resend-verify-email
// ─────────────────────────────────────────────────────────────────────────────
auth.post('/resend-verify-email', async (c) => {
  const body = await c.req.json<{ userId: string }>().catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  if (!body.userId)
    return apiError(c, 400, 'USER_ID_REQUIRED', 'userId required');

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(body.userId)
    .first<UserRow>();

  // Always return success to avoid leaking whether the userId is valid
  if (!user || user.is_active) return c.json({ success: true });

  const allowed = await checkOtpRateLimit(c.env.LINKS_KV, user.email);
  if (!allowed) {
    return apiError(
      c,
      429,
      'TOO_MANY_REQUESTS',
      'Too many requests. Try again later.',
    );
  }

  const code = generateOtp(6);
  const codeHash = await sha256(code);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const appName = await getAppName(c.env);

  try {
    await sendEmail(c.env, {
      to: user.email,
      subject: `${appName} — Verify your email`,
      html: verifyEmailHtml(appName, code),
    });
  } catch {
    return apiError(
      c,
      500,
      'EMAIL_SEND_FAILED',
      'Failed to send verification email. Please try again.',
    );
  }

  await c.env.DB.prepare(
    `DELETE FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_verify' AND used = 0`,
  )
    .bind(body.userId)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO ${tbl(c.env, 'verifications')} (identifier, type, code_hash, expires_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(body.userId, 'email_verify', codeHash, expiresAt)
    .run();

  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
auth.post('/login', async (c) => {
  const body = await c.req
    .json<{ email: string; password: string }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');

  if (!body.email || !body.password) {
    return apiError(
      c,
      400,
      'EMAIL_PASSWORD_REQUIRED',
      'email and password are required',
    );
  }

  const email = body.email.trim().toLowerCase();

  // C1: Rate limit login attempts per email AND per IP (BE-S6)
  const loginAllowed = await checkLoginRateLimit(
    c.env.LINKS_KV,
    email,
    clientIp(c),
  );
  if (!loginAllowed) {
    return apiError(
      c,
      429,
      'TOO_MANY_LOGIN_ATTEMPTS',
      'Too many login attempts. Please try again later.',
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE email = ?1`,
  )
    .bind(email)
    .first<UserRow>();

  if (!user?.is_active) {
    // S4: Run dummy PBKDF2 to normalise response time and prevent user enumeration
    await verifyPassword(body.password, TIMING_DUMMY_HASH);
    return apiError(c, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  }

  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) {
    return apiError(c, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  }

  // C1: Reset failed counter on successful login
  await resetLoginAttempts(c.env.LINKS_KV, email, clientIp(c));

  const methods = getUserMethods(user);

  if (methods.length > 0) {
    const { token: pendingToken, jti } = await signPendingToken(
      user.id,
      methods,
      c.env.JWT_SECRET,
    );
    await setPending2fa(c.env.LINKS_KV, jti, user.id);
    return c.json({ requiresTwoFactor: true, pendingToken, methods });
  }

  // H4: Refresh token goes in HttpOnly cookie, not response body
  const tokens = await issueTokens(user, c.env.JWT_SECRET);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({
    accessToken: tokens.accessToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────────
auth.post('/logout', requireAuth, async (c) => {
  const jti = c.get('userJti');
  const exp = c.get('userTokenExp');
  // S1: Compute TTL from actual token expiry instead of hardcoded constant
  const accessTtl = Math.max(exp - Math.floor(Date.now() / 1000), 0) + 60;
  await denylistJti(c.env.LINKS_KV, jti, accessTtl);

  // C-1: Also denylist the refresh token — prevents stolen cookies surviving logout
  const refreshToken = getRefreshCookie(c);
  if (refreshToken) {
    try {
      const rp = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);
      const refreshTtl =
        Math.max(rp.exp - Math.floor(Date.now() / 1000), 0) + 60;
      await denylistJti(c.env.LINKS_KV, rp.jti, refreshTtl);
    } catch {
      /* token already expired or invalid — nothing to denylist */
    }
  }

  clearRefreshCookie(c);
  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────────────────────────────────────
auth.post('/refresh', async (c) => {
  // H4: Read refresh token from HttpOnly cookie
  const refreshToken = getRefreshCookie(c);
  if (!refreshToken) return apiError(c, 401, 'UNAUTHORIZED', 'Unauthorized');

  // FE-R1: Only a bad token is a 401 (and clears the cookie). The client treats
  // 401 as "session over", so KV/D1 failures must not be reported that way.
  let payload: Awaited<ReturnType<typeof verifyRefreshToken>>;
  try {
    payload = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);
  } catch {
    clearRefreshCookie(c);
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_REFRESH_TOKEN',
      'Invalid or expired refresh token',
    );
  }

  try {
    // C-2: Check denylist BEFORE rotating — prevents use of already-revoked tokens
    if (await isJtiDenylisted(c.env.LINKS_KV, payload.jti)) {
      clearRefreshCookie(c);
      return apiError(c, 401, 'UNAUTHORIZED', 'Unauthorized');
    }

    const user = await c.env.DB.prepare(
      `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
    )
      .bind(payload.sub)
      .first<UserRow>();
    if (!user?.is_active)
      return apiError(c, 401, 'USER_NOT_FOUND', 'User not found');

    // BE-S3: If the account's token_version has changed (password change/reset,
    // admin disable/demote), this refresh token is no longer valid.
    if (user.token_version !== payload.tv) {
      clearRefreshCookie(c);
      return apiError(c, 401, 'UNAUTHORIZED', 'Unauthorized');
    }

    // Rotate only after every read succeeded, so a D1 failure can't burn a
    // still-valid refresh token. S1: TTL from the token's actual exp claim.
    const refreshTtl =
      Math.max(payload.exp - Math.floor(Date.now() / 1000), 0) + 60;
    await denylistJti(c.env.LINKS_KV, payload.jti, refreshTtl);

    const tokens = await issueTokens(user, c.env.JWT_SECRET);
    setRefreshCookie(c, tokens.refreshToken);
    return c.json({ accessToken: tokens.accessToken });
  } catch (err) {
    // Infrastructure failure: keep the cookie, report a retryable 503.
    console.error('refresh failed', err instanceof Error ? err.name : err);
    return apiError(
      c,
      503,
      'SERVICE_UNAVAILABLE',
      'Service temporarily unavailable',
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────
auth.get('/me', requireAuth, async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare(
    `SELECT id, email, username, role, totp_enabled, email_2fa_enabled, passkey_enabled, created_at FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<
      Pick<
        UserRow,
        | 'id'
        | 'email'
        | 'username'
        | 'role'
        | 'totp_enabled'
        | 'email_2fa_enabled'
        | 'passkey_enabled'
        | 'created_at'
      >
    >();

  if (!user) return apiError(c, 404, 'NOT_FOUND', 'Not found');
  return c.json({ user });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/change-password
// ─────────────────────────────────────────────────────────────────────────────
auth.post('/change-password', requireAuth, async (c) => {
  const userId = c.get('userId');
  const exp = c.get('userTokenExp');
  const jti = c.get('userJti');
  const body = await c.req
    .json<{ currentPassword: string; newPassword: string }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  if (!body.currentPassword || !body.newPassword) {
    return apiError(
      c,
      400,
      'CURRENT_PASSWORD_NEW_PASSWORD_REQUIRED',
      'currentPassword and newPassword required',
    );
  }
  if (body.newPassword.length < 8) {
    return apiError(
      c,
      400,
      'PASSWORD_TOO_SHORT',
      'New password must be at least 8 characters',
    );
  }
  if (body.newPassword.length > 256) {
    return apiError(c, 400, 'PASSWORD_TOO_LONG', 'Password too long');
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<UserRow>();
  if (!user) return apiError(c, 404, 'NOT_FOUND', 'Not found');

  const valid = await verifyPassword(body.currentPassword, user.password_hash);
  if (!valid)
    return apiError(
      c,
      401,
      'CURRENT_PASSWORD_INCORRECT',
      'Current password is incorrect',
    );

  const newHash = await hashPassword(body.newPassword);
  await c.env.DB.prepare(
    `UPDATE ${tbl(c.env, 'users')} SET password_hash = ?1, token_version = token_version + 1, updated_at = unixepoch() WHERE id = ?2`,
  )
    .bind(newHash, userId)
    .run();

  // C-3 + S1: Denylist both access and refresh tokens. BE-S3: token_version bump
  // above additionally revokes every other active session.
  const accessTtl = Math.max(exp - Math.floor(Date.now() / 1000), 0) + 60;
  await denylistJti(c.env.LINKS_KV, jti, accessTtl);

  const refreshToken = getRefreshCookie(c);
  if (refreshToken) {
    try {
      const rp = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);
      const refreshTtl =
        Math.max(rp.exp - Math.floor(Date.now() / 1000), 0) + 60;
      await denylistJti(c.env.LINKS_KV, rp.jti, refreshTtl);
    } catch {
      /* already invalid */
    }
  }
  clearRefreshCookie(c);

  return c.json({ success: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2FA — TOTP
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/auth/2fa/totp/setup
// BE-S12: POST (not GET) — the endpoint has a write side effect (it regenerates
// and overwrites totp_secret), so GET semantics were wrong.
auth.post('/2fa/totp/setup', requireAuth, async (c) => {
  const userId = c.get('userId');
  const userEmail = c.get('userEmail');

  const user = await c.env.DB.prepare(
    `SELECT totp_enabled FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'totp_enabled'>>();

  if (user?.totp_enabled) {
    return apiError(c, 409, 'TOTP_ALREADY_ENABLED', 'TOTP is already enabled');
  }

  const secret = generateTotpSecret();
  const appName = await getAppName(c.env);
  const uri = buildTotpUri(secret, userEmail, appName);

  const encrypted = await encryptTotpSecret(secret, c.env.TOTP_ENCRYPTION_KEY);
  await c.env.DB.prepare(
    `UPDATE ${tbl(c.env, 'users')} SET totp_secret = ?1, totp_enabled = 0, updated_at = unixepoch() WHERE id = ?2`,
  )
    .bind(encrypted, userId)
    .run();

  return c.json({ secret, uri });
});

// POST /api/auth/2fa/totp/confirm
auth.post('/2fa/totp/confirm', requireAuth, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ code: string }>().catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  // R6-L1: TOTP confirm only ever validates a 6-digit code — reject anything longer
  if (!body.code || body.code.length > 6)
    return apiError(c, 400, 'CODE_REQUIRED', 'code required');

  // R4-L4: Prevent brute-force of the 6-digit code during setup (max 10 per 2 min)
  const confirmAttempts = await incrementTotpConfirmAttempts(
    c.env.LINKS_KV,
    userId,
  );
  if (confirmAttempts > 10) {
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many attempts. Please set up TOTP again.',
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT totp_secret, totp_enabled FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'totp_secret' | 'totp_enabled'>>();

  if (!user?.totp_secret)
    return apiError(
      c,
      400,
      'NO_TOTP_SETUP_IN_PROGRESS',
      'No TOTP setup in progress',
    );
  if (user.totp_enabled)
    return apiError(c, 409, 'TOTP_ALREADY_CONFIRMED', 'TOTP already confirmed');

  const secret = await decryptTotpSecret(
    user.totp_secret,
    c.env.TOTP_ENCRYPTION_KEY,
  );
  if (!verifyTotp(secret, body.code)) {
    return apiError(c, 400, 'INVALID_CODE', 'Invalid code');
  }

  await resetTotpConfirmAttempts(c.env.LINKS_KV, userId);

  const backupCodes = generateBackupCodes(8);
  const hashedCodes = await Promise.all(
    backupCodes.map((code) => sha256(code.replace(/-/g, ''))),
  );

  await c.env.DB.prepare(
    `UPDATE ${tbl(c.env, 'users')} SET totp_enabled = 1, totp_backup_codes = ?1, updated_at = unixepoch() WHERE id = ?2`,
  )
    .bind(JSON.stringify(hashedCodes), userId)
    .run();

  return c.json({ success: true, backupCodes });
});

// DELETE /api/auth/2fa/totp
auth.delete('/2fa/totp', requireAuth, async (c) => {
  const userId = c.get('userId');

  const body = await c.req
    .json<{ currentPassword?: string }>()
    .catch(() => ({}) as { currentPassword?: string });
  if (!body.currentPassword)
    return apiError(
      c,
      400,
      'CURRENT_PASSWORD_REQUIRED',
      'currentPassword required',
    );

  const user = await c.env.DB.prepare(
    `SELECT password_hash FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'password_hash'>>();
  if (!user) return apiError(c, 404, 'NOT_FOUND', 'Not found');
  if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
    return apiError(
      c,
      401,
      'CURRENT_PASSWORD_INCORRECT',
      'Current password is incorrect',
    );
  }

  await c.env.DB.prepare(
    `UPDATE ${tbl(c.env, 'users')} SET totp_secret = NULL, totp_enabled = 0, totp_backup_codes = NULL, updated_at = unixepoch() WHERE id = ?1`,
  )
    .bind(userId)
    .run();
  return c.json({ success: true });
});

// POST /api/auth/2fa/totp/verify  (during login, uses pendingToken)
auth.post('/2fa/totp/verify', async (c) => {
  const body = await c.req
    .json<{ pendingToken: string; code: string }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  if (!body.pendingToken || !body.code || body.code.length > 16) {
    return apiError(
      c,
      400,
      'PENDING_TOKEN_AND_CODE_REQUIRED',
      'pendingToken and code required',
    );
  }

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }
  if (storedUserId !== pending.sub) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const attempts = await increment2faAttempts(c.env.LINKS_KV, pending.jti);
  if (attempts > 5) {
    await deletePending2fa(c.env.LINKS_KV, pending.jti);
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Please log in again.',
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<UserRow>();

  if (!user?.totp_secret || !user.totp_enabled) {
    return apiError(c, 400, 'TOTP_NOT_CONFIGURED', 'TOTP not configured');
  }
  if (!user.is_active)
    return apiError(c, 403, 'ACCOUNT_DISABLED', 'Account is disabled');

  const secret = await decryptTotpSecret(
    user.totp_secret,
    c.env.TOTP_ENCRYPTION_KEY,
  );

  const isTotpCode = verifyTotp(secret, body.code);
  let isBackup = false;

  if (isTotpCode) {
    const result = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO ${tbl(c.env, 'totp_used')} (user_id, code) VALUES (?1, ?2)`,
    )
      .bind(user.id, body.code)
      .run();
    if (result.meta.changes === 0) {
      return apiError(
        c,
        401,
        'CODE_ALREADY_USED',
        'Code already used. Please wait for the next code.',
      );
    }
  }

  if (!isTotpCode && user.totp_backup_codes) {
    const hashed = await sha256(body.code.replace(/-/g, ''));
    let codes: string[];
    try {
      codes = JSON.parse(user.totp_backup_codes);
    } catch {
      return apiError(c, 401, 'INVALID_CODE', 'Invalid code');
    }
    const oldCodesJson = user.totp_backup_codes;
    const hashedBuf = new TextEncoder().encode(hashed);
    let idx = -1;
    for (let i = 0; i < codes.length; i++) {
      const codeBuf = new TextEncoder().encode(codes[i]);
      if (codeBuf.length === hashedBuf.length) {
        let diff = 0;
        for (let j = 0; j < codeBuf.length; j++)
          diff |= (codeBuf[j] ?? 0) ^ (hashedBuf[j] ?? 0);
        if (diff === 0) idx = i;
      }
    }
    if (idx !== -1) {
      codes.splice(idx, 1);
      const result = await c.env.DB.prepare(
        `UPDATE ${tbl(c.env, 'users')} SET totp_backup_codes = ?1, updated_at = unixepoch() WHERE id = ?2 AND totp_backup_codes = ?3`,
      )
        .bind(JSON.stringify(codes), user.id, oldCodesJson)
        .run();
      if (result.meta.changes > 0) {
        isBackup = true;
      }
    }
  }

  if (!isTotpCode && !isBackup) {
    return apiError(c, 401, 'INVALID_CODE', 'Invalid code');
  }

  await deletePending2fa(c.env.LINKS_KV, pending.jti);
  const tokens = await issueTokens(user, c.env.JWT_SECRET);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({
    accessToken: tokens.accessToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2FA — Email OTP
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/auth/2fa/email-otp/enable
auth.post('/2fa/email-otp/enable', requireAuth, async (c) => {
  const userId = c.get('userId');
  const userEmail = c.get('userEmail');

  const body = await c.req.json<{ code: string }>().catch(() => null);
  if (!body?.code || body.code.length > 6)
    return apiError(c, 400, 'CODE_REQUIRED', 'code required');

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT id, code_hash, attempts FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_verify' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userEmail, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification)
    return apiError(
      c,
      400,
      'NO_VALID_VERIFICATION_CODE',
      'No valid verification code. Please request a new one.',
    );

  if (verification.attempts >= 3) {
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Please request a new code.',
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return apiError(c, 400, 'INVALID_CODE', 'Invalid code');
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET used = 1 WHERE id = ?1`,
    ).bind(verification.id),
    c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'users')} SET email_2fa_enabled = 1, updated_at = unixepoch() WHERE id = ?1`,
    ).bind(userId),
  ]);
  return c.json({ success: true });
});

// POST /api/auth/2fa/email-otp/send-verify  (send code to verify email before enabling)
auth.post('/2fa/email-otp/send-verify', requireAuth, async (c) => {
  const userEmail = c.get('userEmail');

  const allowed = await checkOtpRateLimit(c.env.LINKS_KV, userEmail);
  if (!allowed) {
    return apiError(
      c,
      429,
      'TOO_MANY_REQUESTS',
      'Too many requests. Try again later.',
    );
  }

  const code = generateOtp(6);
  const codeHash = await sha256(code);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const appName = await getAppName(c.env);

  try {
    await sendEmail(c.env, {
      to: userEmail,
      subject: `${appName} — Verification Code`,
      html: otpEmailHtml(appName, code),
    });
  } catch {
    return apiError(
      c,
      500,
      'EMAIL_SEND_FAILED',
      'Failed to send verification email. Please try again.',
    );
  }

  await c.env.DB.prepare(
    `DELETE FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_verify' AND used = 0`,
  )
    .bind(userEmail)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO ${tbl(c.env, 'verifications')} (identifier, type, code_hash, expires_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(userEmail, 'email_verify', codeHash, expiresAt)
    .run();

  return c.json({ success: true });
});

// DELETE /api/auth/2fa/email-otp
auth.delete('/2fa/email-otp', requireAuth, async (c) => {
  const userId = c.get('userId');

  const body = await c.req
    .json<{ currentPassword?: string }>()
    .catch(() => ({}) as { currentPassword?: string });
  if (!body.currentPassword)
    return apiError(
      c,
      400,
      'CURRENT_PASSWORD_REQUIRED',
      'currentPassword required',
    );

  const user = await c.env.DB.prepare(
    `SELECT password_hash FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'password_hash'>>();
  if (!user) return apiError(c, 404, 'NOT_FOUND', 'Not found');
  if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
    return apiError(
      c,
      401,
      'CURRENT_PASSWORD_INCORRECT',
      'Current password is incorrect',
    );
  }

  await c.env.DB.prepare(
    `UPDATE ${tbl(c.env, 'users')} SET email_2fa_enabled = 0, updated_at = unixepoch() WHERE id = ?1`,
  )
    .bind(userId)
    .run();
  return c.json({ success: true });
});

// POST /api/auth/2fa/email-otp/send
auth.post('/2fa/email-otp/send', async (c) => {
  const body = await c.req.json<{ pendingToken: string }>().catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  if (!body.pendingToken)
    return apiError(c, 400, 'PENDING_TOKEN_REQUIRED', 'pendingToken required');

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }
  if (storedUserId !== pending.sub) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<UserRow>();
  if (!user) return apiError(c, 404, 'USER_NOT_FOUND', 'User not found');
  if (!user.is_active)
    return apiError(c, 403, 'ACCOUNT_DISABLED', 'Account is disabled');
  if (!user.email_2fa_enabled)
    return apiError(
      c,
      400,
      'EMAIL_OTP_NOT_ENABLED',
      'Email OTP is not enabled for this account',
    );

  const allowed = await checkOtpRateLimit(c.env.LINKS_KV, user.email);
  if (!allowed) {
    return apiError(
      c,
      429,
      'TOO_MANY_OTP_REQUESTS',
      'Too many OTP requests. Try again later.',
    );
  }

  const code = generateOtp(6);
  const codeHash = await sha256(code);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;

  const appName = await getAppName(c.env);

  try {
    await sendEmail(c.env, {
      to: user.email,
      subject: `${appName} — Verification Code`,
      html: otpEmailHtml(appName, code),
    });
  } catch {
    return apiError(
      c,
      500,
      'EMAIL_SEND_FAILED',
      'Failed to send verification email. Please try again.',
    );
  }

  await c.env.DB.prepare(
    `DELETE FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_otp' AND used = 0`,
  )
    .bind(user.email)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO ${tbl(c.env, 'verifications')} (identifier, type, code_hash, expires_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(user.email, 'email_otp', codeHash, expiresAt)
    .run();

  return c.json({ success: true });
});

// POST /api/auth/2fa/email-otp/verify
auth.post('/2fa/email-otp/verify', async (c) => {
  const body = await c.req
    .json<{ pendingToken: string; code: string }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  if (!body.pendingToken || !body.code || body.code.length > 6) {
    return apiError(
      c,
      400,
      'PENDING_TOKEN_AND_CODE_REQUIRED',
      'pendingToken and code required',
    );
  }

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }
  if (storedUserId !== pending.sub) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const attempts = await increment2faAttempts(c.env.LINKS_KV, pending.jti);
  if (attempts > 5) {
    await deletePending2fa(c.env.LINKS_KV, pending.jti);
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Please log in again.',
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<UserRow>();
  if (!user) return apiError(c, 404, 'USER_NOT_FOUND', 'User not found');
  if (!user.is_active)
    return apiError(c, 403, 'ACCOUNT_DISABLED', 'Account is disabled');
  if (!user.email_2fa_enabled)
    return apiError(
      c,
      400,
      'EMAIL_OTP_NOT_ENABLED',
      'Email OTP is not enabled for this account',
    );

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_otp' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(user.email, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification) {
    return apiError(
      c,
      400,
      'NO_VALID_OTP',
      'No valid OTP found. Please request a new code.',
    );
  }

  if (verification.attempts >= 3) {
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Please request a new code.',
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return apiError(c, 401, 'INVALID_CODE', 'Invalid code');
  }

  await c.env.DB.prepare(
    `UPDATE ${tbl(c.env, 'verifications')} SET used = 1 WHERE id = ?1`,
  )
    .bind(verification.id)
    .run();
  await deletePending2fa(c.env.LINKS_KV, pending.jti);

  const tokens = await issueTokens(user, c.env.JWT_SECRET);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({
    accessToken: tokens.accessToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2FA — Passkey
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/auth/2fa/passkey
auth.get('/2fa/passkey', requireAuth, async (c) => {
  const userId = c.get('userId');
  const passkeys = await c.env.DB.prepare(
    `SELECT id, name, created_at, last_used_at FROM ${tbl(c.env, 'passkeys')} WHERE user_id = ?1`,
  )
    .bind(userId)
    .all<Pick<PasskeyRow, 'id' | 'name' | 'created_at' | 'last_used_at'>>();
  return c.json({ passkeys: passkeys.results });
});

// POST /api/auth/2fa/passkey/register-options
auth.post('/2fa/passkey/register-options', requireAuth, async (c) => {
  const userId = c.get('userId');
  const userEmail = c.get('userEmail');

  const existingPasskeys = await c.env.DB.prepare(
    `SELECT id, transports FROM ${tbl(c.env, 'passkeys')} WHERE user_id = ?1`,
  )
    .bind(userId)
    .all<Pick<PasskeyRow, 'id' | 'transports'>>();

  if (existingPasskeys.results.length >= 10) {
    return apiError(
      c,
      400,
      'TOO_MANY_PASSKEYS',
      'Maximum of 10 passkeys allowed per account',
    );
  }

  const options = await generateRegistrationOptions({
    rpName: c.env.APP_NAME,
    rpID: c.env.RP_ID,
    userID: new TextEncoder().encode(userId) as Uint8Array<ArrayBuffer>,
    userName: userEmail,
    excludeCredentials: existingPasskeys.results.map((pk) => ({
      id: pk.id,
      transports: pk.transports ? JSON.parse(pk.transports) : [],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const challengeId = crypto.randomUUID();
  await setPasskeyChallenge(c.env.LINKS_KV, challengeId, {
    challenge: options.challenge,
    userId,
    type: 'registration',
  });

  return c.json({ options, challengeId });
});

// POST /api/auth/2fa/passkey/register-verify
auth.post('/2fa/passkey/register-verify', requireAuth, async (c) => {
  const userId = c.get('userId');
  const body = await c.req
    .json<{
      response: unknown;
      challengeId: string;
      name?: string;
    }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');

  const stored = await getAndDeletePasskeyChallenge(
    c.env.LINKS_KV,
    body.challengeId,
  );
  if (stored?.type !== 'registration' || stored.userId !== userId) {
    return apiError(
      c,
      400,
      'INVALID_OR_EXPIRED_CHALLENGE',
      'Invalid or expired challenge',
    );
  }

  if (body.name && body.name.length > 64) {
    return apiError(
      c,
      400,
      'PASSKEY_NAME_TOO_LONG',
      'Passkey name must be 64 characters or fewer',
    );
  }

  let verification: Awaited<ReturnType<typeof verifyPasskeyRegistration>>;
  try {
    verification = await verifyPasskeyRegistration(
      body.response,
      stored.challenge as string,
      c.env.RP_ID,
      c.env.APP_ORIGIN,
    );
  } catch {
    return apiError(
      c,
      400,
      'PASSKEY_VERIFICATION_FAILED',
      'Passkey verification failed',
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return apiError(
      c,
      400,
      'PASSKEY_VERIFICATION_FAILED',
      'Passkey verification failed',
    );
  }

  const {
    id: credentialID,
    publicKey: credentialPublicKey,
    counter,
  } = verification.registrationInfo.credential;
  const publicKeyB64 = uint8ArrayToBase64Url(credentialPublicKey);
  const responseBody = body.response as {
    response?: { transports?: unknown[] };
  };
  const transports = (responseBody.response?.transports ?? [])
    .filter((t): t is string => typeof t === 'string' && t.length <= 32)
    .slice(0, 8);

  await c.env.DB.prepare(
    `INSERT INTO ${tbl(c.env, 'passkeys')} (id, user_id, public_key, counter, name, aaguid, transports) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      credentialID,
      userId,
      publicKeyB64,
      counter,
      body.name ?? null,
      verification.registrationInfo.aaguid ?? null,
      JSON.stringify(transports),
    )
    .run();

  await c.env.DB.prepare(
    `UPDATE ${tbl(c.env, 'users')} SET passkey_enabled = 1, updated_at = unixepoch() WHERE id = ?1`,
  )
    .bind(userId)
    .run();

  return c.json({ success: true, credentialId: credentialID });
});

// DELETE /api/auth/2fa/passkey/:id
auth.delete('/2fa/passkey/:id', requireAuth, async (c) => {
  const userId = c.get('userId');
  const credId = c.req.param('id');

  const body = await c.req
    .json<{ currentPassword?: string }>()
    .catch(() => ({}) as { currentPassword?: string });
  if (!body.currentPassword)
    return apiError(
      c,
      400,
      'CURRENT_PASSWORD_REQUIRED',
      'currentPassword required',
    );

  const userCheck = await c.env.DB.prepare(
    `SELECT password_hash FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'password_hash'>>();
  if (!userCheck) return apiError(c, 404, 'NOT_FOUND', 'Not found');
  if (!(await verifyPassword(body.currentPassword, userCheck.password_hash))) {
    return apiError(
      c,
      401,
      'CURRENT_PASSWORD_INCORRECT',
      'Current password is incorrect',
    );
  }

  await c.env.DB.prepare(
    `DELETE FROM ${tbl(c.env, 'passkeys')} WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(credId, userId)
    .run();

  const remaining = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM ${tbl(c.env, 'passkeys')} WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ n: number }>();

  if (!remaining?.n) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'users')} SET passkey_enabled = 0, updated_at = unixepoch() WHERE id = ?1`,
    )
      .bind(userId)
      .run();
  }

  return c.json({ success: true });
});

// POST /api/auth/2fa/passkey/verify-options  (during login flow)
auth.post('/2fa/passkey/verify-options', async (c) => {
  const body = await c.req.json<{ pendingToken: string }>().catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  if (!body.pendingToken)
    return apiError(c, 400, 'PENDING_TOKEN_REQUIRED', 'pendingToken required');

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }
  if (storedUserId !== pending.sub) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const optionsAttempts = await incrementPasskeyOptsAttempts(
    c.env.LINKS_KV,
    pending.jti,
  );
  if (optionsAttempts > 10) {
    await deletePending2fa(c.env.LINKS_KV, pending.jti);
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many requests. Please log in again.',
    );
  }

  const userActive = await c.env.DB.prepare(
    `SELECT is_active FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<Pick<UserRow, 'is_active'>>();
  if (!userActive?.is_active)
    return apiError(c, 403, 'ACCOUNT_DISABLED', 'Account is disabled');

  const passkeys = await c.env.DB.prepare(
    `SELECT id, transports FROM ${tbl(c.env, 'passkeys')} WHERE user_id = ?1`,
  )
    .bind(pending.sub)
    .all<Pick<PasskeyRow, 'id' | 'transports'>>();

  const options = await generateAuthenticationOptions({
    rpID: c.env.RP_ID,
    allowCredentials: passkeys.results.map((pk) => ({
      id: pk.id,
      transports: pk.transports ? JSON.parse(pk.transports) : [],
    })),
    userVerification: 'preferred',
  });

  const challengeId = crypto.randomUUID();
  await setPasskeyChallenge(c.env.LINKS_KV, challengeId, {
    challenge: options.challenge,
    userId: pending.sub,
    type: 'authentication',
    pendingJti: pending.jti,
  });

  return c.json({ options, challengeId });
});

// POST /api/auth/2fa/passkey/verify  (during login flow)
auth.post('/2fa/passkey/verify', async (c) => {
  const body = await c.req
    .json<{
      pendingToken: string;
      response: unknown;
      challengeId: string;
    }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }
  if (storedUserId !== pending.sub) {
    return apiError(
      c,
      401,
      'INVALID_OR_EXPIRED_PENDING_TOKEN',
      'Invalid or expired pending token',
    );
  }

  const passkeyAttempts = await increment2faAttempts(
    c.env.LINKS_KV,
    pending.jti,
  );
  if (passkeyAttempts > 5) {
    await deletePending2fa(c.env.LINKS_KV, pending.jti);
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Please log in again.',
    );
  }

  const stored = await getAndDeletePasskeyChallenge(
    c.env.LINKS_KV,
    body.challengeId,
  );
  if (
    stored?.type !== 'authentication' ||
    stored.userId !== pending.sub ||
    stored.pendingJti !== pending.jti
  ) {
    return apiError(
      c,
      400,
      'INVALID_OR_EXPIRED_CHALLENGE',
      'Invalid or expired challenge',
    );
  }

  const passkey = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'passkeys')} WHERE id = ?1 AND user_id = ?2`,
  )
    .bind((body.response as { id: string }).id, pending.sub)
    .first<PasskeyRow>();

  if (!passkey)
    return apiError(c, 404, 'PASSKEY_NOT_FOUND', 'Passkey not found');

  let verification: Awaited<ReturnType<typeof verifyPasskeyAuthentication>>;
  try {
    verification = await verifyPasskeyAuthentication(
      body.response,
      stored.challenge as string,
      c.env.RP_ID,
      c.env.APP_ORIGIN,
      passkey,
    );
  } catch {
    return apiError(
      c,
      400,
      'PASSKEY_VERIFICATION_FAILED',
      'Passkey verification failed',
    );
  }

  if (!verification.verified)
    return apiError(
      c,
      401,
      'PASSKEY_VERIFICATION_FAILED',
      'Passkey verification failed',
    );

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<UserRow>();
  if (!user) return apiError(c, 404, 'USER_NOT_FOUND', 'User not found');
  if (!user.is_active)
    return apiError(c, 403, 'ACCOUNT_DISABLED', 'Account is disabled');

  await c.env.DB.prepare(
    `UPDATE ${tbl(c.env, 'passkeys')} SET counter = ?1, last_used_at = unixepoch() WHERE id = ?2`,
  )
    .bind(verification.authenticationInfo.newCounter, passkey.id)
    .run();

  await deletePending2fa(c.env.LINKS_KV, pending.jti);

  const tokens = await issueTokens(user, c.env.JWT_SECRET);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({
    accessToken: tokens.accessToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Forgot / Reset Password
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/auth/verify-reset-code  (verify code only, does not consume it)
auth.post('/verify-reset-code', async (c) => {
  const body = await c.req
    .json<{ email: string; code: string }>()
    .catch(() => null);
  if (!body?.email || !body?.code || body.code.length > 6) {
    return apiError(
      c,
      400,
      'EMAIL_AND_CODE_REQUIRED',
      'email and code are required',
    );
  }

  const email = body.email.trim().toLowerCase();
  const user = await c.env.DB.prepare(
    `SELECT id FROM ${tbl(c.env, 'users')} WHERE email = ?1 AND is_active = 1`,
  )
    .bind(email)
    .first<{ id: string }>();
  if (!user)
    return apiError(
      c,
      400,
      'INVALID_OR_EXPIRED_CODE',
      'Invalid or expired code',
    );

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT id, code_hash, attempts FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'password_reset' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification)
    return apiError(
      c,
      400,
      'INVALID_OR_EXPIRED_CODE',
      'Invalid or expired code',
    );

  if (verification.attempts >= 3) {
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Please request a new code.',
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return apiError(c, 400, 'INVALID_CODE', 'Invalid code');
  }

  return c.json({ success: true });
});

// POST /api/auth/forgot-password
auth.post('/forgot-password', async (c) => {
  const body = await c.req.json<{ email: string }>().catch(() => null);
  if (!body?.email) return c.json({ success: true }); // silent — no enumeration

  const email = body.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return c.json({ success: true });

  // Rate limit using same KV bucket as email OTP, plus an IP dimension (BE-S6)
  // so an attacker can't mail-bomb arbitrary victim addresses.
  const allowed = await checkOtpRateLimit(c.env.LINKS_KV, email);
  const ipAllowed = await checkForgotPasswordIpRateLimit(
    c.env.LINKS_KV,
    clientIp(c),
  );
  if (!allowed || !ipAllowed) {
    return apiError(
      c,
      429,
      'TOO_MANY_REQUESTS',
      'Too many requests. Try again later.',
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT id FROM ${tbl(c.env, 'users')} WHERE email = ?1 AND is_active = 1`,
  )
    .bind(email)
    .first<{ id: string }>();

  if (!user) return c.json({ success: true }); // silent — no enumeration

  // BE-S9: send the reset email out-of-band so the response time no longer
  // reveals whether the address is registered (previously the send happened
  // inline, so an existing address took hundreds of ms longer to respond).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const code = generateOtp(6);
        const codeHash = await sha256(code);
        const expiresAt = Math.floor(Date.now() / 1000) + 600;

        // Persist the code BEFORE sending, so a user never receives a code that
        // failed to store. Invalidate any previous unused reset codes first.
        await c.env.DB.prepare(
          `DELETE FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'password_reset' AND used = 0`,
        )
          .bind(email)
          .run();

        await c.env.DB.prepare(
          `INSERT INTO ${tbl(c.env, 'verifications')} (identifier, type, code_hash, expires_at) VALUES (?1, ?2, ?3, ?4)`,
        )
          .bind(email, 'password_reset', codeHash, expiresAt)
          .run();

        const appName = await getAppName(c.env);
        await sendEmail(c.env, {
          to: email,
          subject: `${appName} — Password Reset`,
          html: resetPasswordEmailHtml(appName, code),
        });
      } catch (err) {
        // BE-R2: log only a redacted form — never the upstream response body.
        console.error(
          'forgot-password background task failed',
          err instanceof Error ? err.name : typeof err,
        );
      }
    })(),
  );

  return c.json({ success: true });
});

// POST /api/auth/reset-password
auth.post('/reset-password', async (c) => {
  const body = await c.req
    .json<{ email: string; code: string; newPassword: string }>()
    .catch(() => null);
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');
  if (!body.email || !body.code || !body.newPassword) {
    return apiError(
      c,
      400,
      'EMAIL_CODE_NEW_PASSWORD_REQUIRED',
      'email, code, and newPassword are required',
    );
  }
  if (body.code.length > 6)
    return apiError(c, 400, 'INVALID_CODE', 'Invalid code');
  if (body.newPassword.length < 8)
    return apiError(
      c,
      400,
      'PASSWORD_TOO_SHORT',
      'Password must be at least 8 characters',
    );
  if (body.newPassword.length > 256)
    return apiError(c, 400, 'PASSWORD_TOO_LONG', 'Password too long');

  const email = body.email.trim().toLowerCase();

  const user = await c.env.DB.prepare(
    `SELECT id FROM ${tbl(c.env, 'users')} WHERE email = ?1 AND is_active = 1`,
  )
    .bind(email)
    .first<{ id: string }>();
  if (!user)
    return apiError(
      c,
      400,
      'INVALID_OR_EXPIRED_CODE',
      'Invalid or expired code',
    );

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'password_reset' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification)
    return apiError(
      c,
      400,
      'INVALID_OR_EXPIRED_CODE',
      'Invalid or expired code',
    );

  if (verification.attempts >= 3) {
    return apiError(
      c,
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Please request a new code.',
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return apiError(c, 400, 'INVALID_CODE', 'Invalid code');
  }

  const newHash = await hashPassword(body.newPassword);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET used = 1 WHERE id = ?1`,
    ).bind(verification.id),
    c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'users')} SET password_hash = ?1, token_version = token_version + 1, updated_at = unixepoch() WHERE id = ?2`,
    ).bind(newHash, user.id),
  ]);

  return c.json({ success: true });
});

export default auth;
