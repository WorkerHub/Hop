import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  generateOtp,
  hashPassword,
  sha256,
  verifyPassword,
} from '../lib/crypto.js';
import { tbl } from '../lib/db.js';
import {
  otpEmailHtml,
  resetPasswordEmailHtml,
  sendEmail,
  verifyEmailHtml,
} from '../lib/email.js';
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  if (!body.email || !body.username || !body.password) {
    return c.json({ error: 'email, username, and password are required' }, 400);
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
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  }

  // M4: Input validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Invalid email address' }, 400);
  }
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return c.json(
      {
        error:
          'Username must be 3–32 characters: letters, numbers, dashes, or underscores',
      },
      400,
    );
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }
  if (password.length > 256) {
    return c.json({ error: 'Password too long' }, 400);
  }

  // H3: Check registration status before INSERT
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM ${tbl(c.env, 'users')}`,
  ).first<{ n: number }>();
  const isFirstUser = (countRow?.n ?? 0) === 0;

  if (!isFirstUser) {
    const enabled = await isRegistrationEnabled(c.env);
    if (!enabled) {
      return c.json({ error: 'Registration is currently disabled' }, 403);
    }
  }

  // Check uniqueness
  const existing = await c.env.DB.prepare(
    `SELECT id FROM ${tbl(c.env, 'users')} WHERE email = ?1 OR username = ?2`,
  )
    .bind(email, username)
    .first();
  if (existing) {
    return c.json({ error: 'Email or username already taken' }, 409);
  }

  const passwordHash = await hashPassword(password);

  // If email verification is required (non-first user only), create account as inactive
  // and send a verification code before the user can log in.
  if (!isFirstUser && (await isEmailVerificationRequired(c.env))) {
    const newUser = await c.env.DB.prepare(
      `INSERT INTO ${tbl(c.env, 'users')} (email, username, password_hash, role, is_active)
       VALUES (?1, ?2, ?3, 'user', 0)
       RETURNING id, email, username, role`,
    )
      .bind(email, username, passwordHash)
      .first<{ id: string; email: string; username: string; role: string }>();

    if (!newUser) return c.json({ error: 'Failed to create user' }, 500);

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
      return c.json(
        { error: 'Failed to send verification email. Please try again.' },
        500,
      );
    }

    await c.env.DB.prepare(
      `INSERT INTO ${tbl(c.env, 'verifications')} (identifier, type, code_hash, expires_at) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(newUser.id, 'email_verify', codeHash, expiresAt)
      .run();

    return c.json({ requiresEmailVerification: true, userId: newUser.id }, 201);
  }

  // H3: Role assigned atomically inside SQL — prevents bootstrap race condition
  const result = await c.env.DB.prepare(
    `INSERT INTO ${tbl(c.env, 'users')} (email, username, password_hash, role)
     VALUES (?1, ?2, ?3, CASE WHEN (SELECT COUNT(*) FROM ${tbl(c.env, 'users')}) = 0 THEN 'admin' ELSE 'user' END)
     RETURNING id, email, username, role`,
  )
    .bind(email, username, passwordHash)
    .first<{ id: string; email: string; username: string; role: string }>();

  if (!result) return c.json({ error: 'Failed to create user' }, 500);

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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!body.userId || !body.code || body.code.length > 6) {
    return c.json({ error: 'userId and code required' }, 400);
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(body.userId)
    .first<UserRow>();

  if (!user || user.is_active) {
    return c.json({ error: 'Invalid or expired verification' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_verify' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(body.userId, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification) {
    return c.json({ error: 'Invalid or expired verification code' }, 400);
  }

  if (verification.attempts >= 3) {
    return c.json(
      { error: 'Too many failed attempts. Please request a new code.' },
      429,
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return c.json({ error: 'Invalid code' }, 401);
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!body.userId) return c.json({ error: 'userId required' }, 400);

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(body.userId)
    .first<UserRow>();

  // Always return success to avoid leaking whether the userId is valid
  if (!user || user.is_active) return c.json({ success: true });

  const allowed = await checkOtpRateLimit(c.env.LINKS_KV, user.email);
  if (!allowed) {
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
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
    return c.json(
      { error: 'Failed to send verification email. Please try again.' },
      500,
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required' }, 400);
  }

  const email = body.email.trim().toLowerCase();

  // C1: Rate limit login attempts per email AND per IP (BE-S6)
  const loginAllowed = await checkLoginRateLimit(
    c.env.LINKS_KV,
    email,
    clientIp(c),
  );
  if (!loginAllowed) {
    return c.json(
      { error: 'Too many login attempts. Please try again later.' },
      429,
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
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
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
  if (!refreshToken) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const payload = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);

    // C-2: Check denylist BEFORE rotating — prevents use of already-revoked tokens
    if (await isJtiDenylisted(c.env.LINKS_KV, payload.jti)) {
      clearRefreshCookie(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // S1: Compute remaining TTL from token's actual exp claim
    const refreshTtl =
      Math.max(payload.exp - Math.floor(Date.now() / 1000), 0) + 60;
    await denylistJti(c.env.LINKS_KV, payload.jti, refreshTtl);

    const user = await c.env.DB.prepare(
      `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
    )
      .bind(payload.sub)
      .first<UserRow>();
    if (!user?.is_active) return c.json({ error: 'User not found' }, 401);

    // BE-S3: If the account's token_version has changed (password change/reset,
    // admin disable/demote), this refresh token is no longer valid.
    if (user.token_version !== payload.tv) {
      clearRefreshCookie(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const tokens = await issueTokens(user, c.env.JWT_SECRET);
    setRefreshCookie(c, tokens.refreshToken);
    return c.json({ accessToken: tokens.accessToken });
  } catch {
    clearRefreshCookie(c);
    return c.json({ error: 'Invalid or expired refresh token' }, 401);
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

  if (!user) return c.json({ error: 'Not found' }, 404);
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!body.currentPassword || !body.newPassword) {
    return c.json({ error: 'currentPassword and newPassword required' }, 400);
  }
  if (body.newPassword.length < 8) {
    return c.json({ error: 'New password must be at least 8 characters' }, 400);
  }
  if (body.newPassword.length > 256) {
    return c.json({ error: 'Password too long' }, 400);
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<UserRow>();
  if (!user) return c.json({ error: 'Not found' }, 404);

  const valid = await verifyPassword(body.currentPassword, user.password_hash);
  if (!valid) return c.json({ error: 'Current password is incorrect' }, 401);

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

// GET /api/auth/2fa/totp/setup
auth.get('/2fa/totp/setup', requireAuth, async (c) => {
  const userId = c.get('userId');
  const userEmail = c.get('userEmail');

  const user = await c.env.DB.prepare(
    `SELECT totp_enabled FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'totp_enabled'>>();

  if (user?.totp_enabled) {
    return c.json({ error: 'TOTP is already enabled' }, 409);
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  // R6-L1: TOTP confirm only ever validates a 6-digit code — reject anything longer
  if (!body.code || body.code.length > 6)
    return c.json({ error: 'code required' }, 400);

  // R4-L4: Prevent brute-force of the 6-digit code during setup (max 10 per 2 min)
  const confirmAttempts = await incrementTotpConfirmAttempts(
    c.env.LINKS_KV,
    userId,
  );
  if (confirmAttempts > 10) {
    return c.json(
      { error: 'Too many attempts. Please set up TOTP again.' },
      429,
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT totp_secret, totp_enabled FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'totp_secret' | 'totp_enabled'>>();

  if (!user?.totp_secret)
    return c.json({ error: 'No TOTP setup in progress' }, 400);
  if (user.totp_enabled)
    return c.json({ error: 'TOTP already confirmed' }, 409);

  const secret = await decryptTotpSecret(
    user.totp_secret,
    c.env.TOTP_ENCRYPTION_KEY,
  );
  if (!verifyTotp(secret, body.code)) {
    return c.json({ error: 'Invalid code' }, 400);
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
    return c.json({ error: 'currentPassword required' }, 400);

  const user = await c.env.DB.prepare(
    `SELECT password_hash FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'password_hash'>>();
  if (!user) return c.json({ error: 'Not found' }, 404);
  if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!body.pendingToken || !body.code || body.code.length > 16) {
    return c.json({ error: 'pendingToken and code required' }, 400);
  }

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }
  if (storedUserId !== pending.sub) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const attempts = await increment2faAttempts(c.env.LINKS_KV, pending.jti);
  if (attempts > 5) {
    await deletePending2fa(c.env.LINKS_KV, pending.jti);
    return c.json(
      { error: 'Too many failed attempts. Please log in again.' },
      429,
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<UserRow>();

  if (!user?.totp_secret || !user.totp_enabled) {
    return c.json({ error: 'TOTP not configured' }, 400);
  }
  if (!user.is_active) return c.json({ error: 'Account is disabled' }, 403);

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
      return c.json(
        { error: 'Code already used. Please wait for the next code.' },
        401,
      );
    }
  }

  if (!isTotpCode && user.totp_backup_codes) {
    const hashed = await sha256(body.code.replace(/-/g, ''));
    let codes: string[];
    try {
      codes = JSON.parse(user.totp_backup_codes);
    } catch {
      return c.json({ error: 'Invalid code' }, 401);
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
    return c.json({ error: 'Invalid code' }, 401);
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
    return c.json({ error: 'code required' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT id, code_hash, attempts FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_verify' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userEmail, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification)
    return c.json(
      { error: 'No valid verification code. Please request a new one.' },
      400,
    );

  if (verification.attempts >= 3) {
    return c.json(
      { error: 'Too many failed attempts. Please request a new code.' },
      429,
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return c.json({ error: 'Invalid code' }, 400);
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
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
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
    return c.json(
      { error: 'Failed to send verification email. Please try again.' },
      500,
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
    return c.json({ error: 'currentPassword required' }, 400);

  const user = await c.env.DB.prepare(
    `SELECT password_hash FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'password_hash'>>();
  if (!user) return c.json({ error: 'Not found' }, 404);
  if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!body.pendingToken)
    return c.json({ error: 'pendingToken required' }, 400);

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }
  if (storedUserId !== pending.sub) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<UserRow>();
  if (!user) return c.json({ error: 'User not found' }, 404);
  if (!user.is_active) return c.json({ error: 'Account is disabled' }, 403);
  if (!user.email_2fa_enabled)
    return c.json({ error: 'Email OTP is not enabled for this account' }, 400);

  const allowed = await checkOtpRateLimit(c.env.LINKS_KV, user.email);
  if (!allowed) {
    return c.json({ error: 'Too many OTP requests. Try again later.' }, 429);
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
    return c.json(
      { error: 'Failed to send verification email. Please try again.' },
      500,
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!body.pendingToken || !body.code || body.code.length > 6) {
    return c.json({ error: 'pendingToken and code required' }, 400);
  }

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }
  if (storedUserId !== pending.sub) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const attempts = await increment2faAttempts(c.env.LINKS_KV, pending.jti);
  if (attempts > 5) {
    await deletePending2fa(c.env.LINKS_KV, pending.jti);
    return c.json(
      { error: 'Too many failed attempts. Please log in again.' },
      429,
    );
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<UserRow>();
  if (!user) return c.json({ error: 'User not found' }, 404);
  if (!user.is_active) return c.json({ error: 'Account is disabled' }, 403);
  if (!user.email_2fa_enabled)
    return c.json({ error: 'Email OTP is not enabled for this account' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'email_otp' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(user.email, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification) {
    return c.json(
      { error: 'No valid OTP found. Please request a new code.' },
      400,
    );
  }

  if (verification.attempts >= 3) {
    return c.json(
      { error: 'Too many failed attempts. Please request a new code.' },
      429,
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return c.json({ error: 'Invalid code' }, 401);
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
    return c.json({ error: 'Maximum of 10 passkeys allowed per account' }, 400);
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const stored = await getAndDeletePasskeyChallenge(
    c.env.LINKS_KV,
    body.challengeId,
  );
  if (stored?.type !== 'registration' || stored.userId !== userId) {
    return c.json({ error: 'Invalid or expired challenge' }, 400);
  }

  if (body.name && body.name.length > 64) {
    return c.json(
      { error: 'Passkey name must be 64 characters or fewer' },
      400,
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
    return c.json({ error: 'Passkey verification failed' }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'Passkey verification failed' }, 400);
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
    return c.json({ error: 'currentPassword required' }, 400);

  const userCheck = await c.env.DB.prepare(
    `SELECT password_hash FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(userId)
    .first<Pick<UserRow, 'password_hash'>>();
  if (!userCheck) return c.json({ error: 'Not found' }, 404);
  if (!(await verifyPassword(body.currentPassword, userCheck.password_hash))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!body.pendingToken)
    return c.json({ error: 'pendingToken required' }, 400);

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }
  if (storedUserId !== pending.sub) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const optionsAttempts = await incrementPasskeyOptsAttempts(
    c.env.LINKS_KV,
    pending.jti,
  );
  if (optionsAttempts > 10) {
    await deletePending2fa(c.env.LINKS_KV, pending.jti);
    return c.json({ error: 'Too many requests. Please log in again.' }, 429);
  }

  const userActive = await c.env.DB.prepare(
    `SELECT is_active FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<Pick<UserRow, 'is_active'>>();
  if (!userActive?.is_active)
    return c.json({ error: 'Account is disabled' }, 403);

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
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  let pending: Awaited<ReturnType<typeof verifyPendingToken>>;
  try {
    pending = await verifyPendingToken(body.pendingToken, c.env.JWT_SECRET);
  } catch {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const storedUserId = await getPending2fa(c.env.LINKS_KV, pending.jti);
  if (!storedUserId) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }
  if (storedUserId !== pending.sub) {
    return c.json({ error: 'Invalid or expired pending token' }, 401);
  }

  const passkeyAttempts = await increment2faAttempts(
    c.env.LINKS_KV,
    pending.jti,
  );
  if (passkeyAttempts > 5) {
    await deletePending2fa(c.env.LINKS_KV, pending.jti);
    return c.json(
      { error: 'Too many failed attempts. Please log in again.' },
      429,
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
    return c.json({ error: 'Invalid or expired challenge' }, 400);
  }

  const passkey = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'passkeys')} WHERE id = ?1 AND user_id = ?2`,
  )
    .bind((body.response as { id: string }).id, pending.sub)
    .first<PasskeyRow>();

  if (!passkey) return c.json({ error: 'Passkey not found' }, 404);

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
    return c.json({ error: 'Passkey verification failed' }, 400);
  }

  if (!verification.verified)
    return c.json({ error: 'Passkey verification failed' }, 401);

  const user = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(pending.sub)
    .first<UserRow>();
  if (!user) return c.json({ error: 'User not found' }, 404);
  if (!user.is_active) return c.json({ error: 'Account is disabled' }, 403);

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
    return c.json({ error: 'email and code are required' }, 400);
  }

  const email = body.email.trim().toLowerCase();
  const user = await c.env.DB.prepare(
    `SELECT id FROM ${tbl(c.env, 'users')} WHERE email = ?1 AND is_active = 1`,
  )
    .bind(email)
    .first<{ id: string }>();
  if (!user) return c.json({ error: 'Invalid or expired code' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT id, code_hash, attempts FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'password_reset' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification) return c.json({ error: 'Invalid or expired code' }, 400);

  if (verification.attempts >= 3) {
    return c.json(
      { error: 'Too many failed attempts. Please request a new code.' },
      429,
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return c.json({ error: 'Invalid code' }, 400);
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
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  }

  const user = await c.env.DB.prepare(
    `SELECT id FROM ${tbl(c.env, 'users')} WHERE email = ?1 AND is_active = 1`,
  )
    .bind(email)
    .first<{ id: string }>();

  if (!user) return c.json({ success: true }); // silent — no enumeration

  const code = generateOtp(6);
  const codeHash = await sha256(code);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const appName = await getAppName(c.env);

  try {
    await sendEmail(c.env, {
      to: email,
      subject: `${appName} — Password Reset`,
      html: resetPasswordEmailHtml(appName, code),
    });
  } catch {
    return c.json({ error: 'Failed to send email. Please try again.' }, 500);
  }

  // Invalidate any previous unused reset codes for this email
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

  return c.json({ success: true });
});

// POST /api/auth/reset-password
auth.post('/reset-password', async (c) => {
  const body = await c.req
    .json<{ email: string; code: string; newPassword: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!body.email || !body.code || !body.newPassword) {
    return c.json({ error: 'email, code, and newPassword are required' }, 400);
  }
  if (body.code.length > 6) return c.json({ error: 'Invalid code' }, 400);
  if (body.newPassword.length < 8)
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  if (body.newPassword.length > 256)
    return c.json({ error: 'Password too long' }, 400);

  const email = body.email.trim().toLowerCase();

  const user = await c.env.DB.prepare(
    `SELECT id FROM ${tbl(c.env, 'users')} WHERE email = ?1 AND is_active = 1`,
  )
    .bind(email)
    .first<{ id: string }>();
  if (!user) return c.json({ error: 'Invalid or expired code' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const verification = await c.env.DB.prepare(
    `SELECT * FROM ${tbl(c.env, 'verifications')} WHERE identifier = ?1 AND type = 'password_reset' AND used = 0 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email, now)
    .first<{ id: string; code_hash: string; attempts: number }>();

  if (!verification) return c.json({ error: 'Invalid or expired code' }, 400);

  if (verification.attempts >= 3) {
    return c.json(
      { error: 'Too many failed attempts. Please request a new code.' },
      429,
    );
  }

  const inputHash = await sha256(body.code);
  if (inputHash !== verification.code_hash) {
    await c.env.DB.prepare(
      `UPDATE ${tbl(c.env, 'verifications')} SET attempts = attempts + 1 WHERE id = ?1`,
    )
      .bind(verification.id)
      .run();
    return c.json({ error: 'Invalid code' }, 400);
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
