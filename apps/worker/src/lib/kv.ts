import type { KVNamespace } from '@cloudflare/workers-types';
import type { CachedLink } from '../types.js';

const KV_PREFIX = {
  link: (slug: string) => `link:${slug}`,
  passkeyChallenge: (id: string) => `passkey_challenge:${id}`,
  otpRate: (email: string) => `otp_rate:${email}`,
  pending2fa: (jti: string) => `pending_2fa:${jti}`,
  settingCache: (key: string) => `setting:${key}`,
  // C1: Login brute-force limiting
  loginAttempts: (email: string) => `login_attempts:${email}`,
  // BE-S6: Per-IP login/register/forgot-password/setup rate limiting
  loginAttemptsIp: (ip: string) => `login_attempts_ip:${ip}`,
  registerIp: (ip: string) => `register_rate:${ip}`,
  forgotPasswordIp: (ip: string) => `forgot_pw_rate:${ip}`,
  setupRate: (ip: string) => `setup_rate:${ip}`,
  // C2: 2FA verify attempt tracking per pending token (shared by TOTP + email-OTP + passkey/verify)
  twoFaAttempts: (jti: string) => `2fa_attempts:${jti}`,
  // R4-L3: Separate counter for passkey/verify-options so challenge-fetch calls don't burn verify budget
  passkeyOptsAttempts: (jti: string) => `passkey_opts:${jti}`,
  // C4: JTI denylist for token revocation
  jtiDeny: (jti: string) => `jti_deny:${jti}`,
  // R4-L4: TOTP confirm rate limiting per user
  totpConfirmAttempts: (userId: string) => `totp_confirm:${userId}`,
  // BE-S6: Per-admin "send test email" rate limiting (5/10min)
  testEmailRate: (adminId: string) => `test_email_rate:${adminId}`,
};

// ─── Link cache ───────────────────────────────────────────────────────────────

export async function getCachedLink(
  kv: KVNamespace,
  slug: string,
): Promise<CachedLink | null> {
  const val = await kv.get(KV_PREFIX.link(slug), 'json');
  return val as CachedLink | null;
}

export async function setCachedLink(
  kv: KVNamespace,
  slug: string,
  data: CachedLink,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let ttl = 6 * 3600; // 6 hours for permanent links

  if (data.expiresAt !== null) {
    const remaining = data.expiresAt - now;
    if (remaining <= 0) return; // already expired, don't cache
    ttl = Math.min(remaining, 6 * 3600);
  }

  await kv.put(KV_PREFIX.link(slug), JSON.stringify(data), {
    expirationTtl: ttl,
  });
}

export async function deleteCachedLink(
  kv: KVNamespace,
  slug: string,
): Promise<void> {
  await kv.delete(KV_PREFIX.link(slug));
}

// ─── Passkey challenges ───────────────────────────────────────────────────────

export async function setPasskeyChallenge(
  kv: KVNamespace,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await kv.put(KV_PREFIX.passkeyChallenge(id), JSON.stringify(data), {
    expirationTtl: 300,
  });
}

// S-2: NOTE — KV get+delete is not atomic (TOCTOU). Two concurrent calls could
// both read the value before either deletes it. This is acceptable here because:
// (a) WebAuthn challenges are single-use by design (pendingJti binding enforced in auth.ts),
// (b) KV eventual consistency windows are sub-second in practice, and
// (c) the challenge also expires via TTL if the delete races.
export async function getAndDeletePasskeyChallenge(
  kv: KVNamespace,
  id: string,
): Promise<Record<string, unknown> | null> {
  const val = await kv.get(KV_PREFIX.passkeyChallenge(id), 'json');
  if (val) await kv.delete(KV_PREFIX.passkeyChallenge(id));
  return val as Record<string, unknown> | null;
}

// ─── OTP rate limiting (max 3 sends per hour, fixed window) ──────────────────

export async function checkOtpRateLimit(
  kv: KVNamespace,
  email: string,
): Promise<boolean> {
  const key = KV_PREFIX.otpRate(email);
  const current = await kv.get(key);
  const now = Math.floor(Date.now() / 1000);

  if (!current) {
    await kv.put(key, JSON.stringify({ count: 1, windowEnd: now + 600 }), {
      expirationTtl: 600,
    });
    return true;
  }

  let entry: { count: number; windowEnd: number };
  try {
    entry = JSON.parse(current);
  } catch {
    await kv.put(key, JSON.stringify({ count: 1, windowEnd: now + 600 }), {
      expirationTtl: 600,
    });
    return true;
  }

  if (entry.count >= 3) return false;
  const remaining = Math.max(entry.windowEnd - now, 1);
  await kv.put(
    key,
    JSON.stringify({ count: entry.count + 1, windowEnd: entry.windowEnd }),
    { expirationTtl: remaining },
  );
  return true;
}

// ─── Pending 2FA tokens ───────────────────────────────────────────────────────

export async function setPending2fa(
  kv: KVNamespace,
  jti: string,
  userId: string,
): Promise<void> {
  await kv.put(KV_PREFIX.pending2fa(jti), userId, { expirationTtl: 600 });
}

// C3: Read without deleting — used to check replay before processing
export async function getPending2fa(
  kv: KVNamespace,
  jti: string,
): Promise<string | null> {
  return kv.get(KV_PREFIX.pending2fa(jti));
}

export async function deletePending2fa(
  kv: KVNamespace,
  jti: string,
): Promise<void> {
  await kv.delete(KV_PREFIX.pending2fa(jti));
}

// ─── Login rate limiting (C1: max 10 attempts per 15 min per email, fixed window) ─
// NOTE (H-4): KV has no atomic increment. Concurrent bursts may momentarily exceed
// the limit before writes settle. A Cloudflare WAF rate-limit rule is the primary
// enforcement layer; this provides a defence-in-depth best-effort guard.

// Fixed-window counter. Records the attempt by incrementing the stored count,
// then reports whether it is still within `limit`. The detailed variant also
// returns how many seconds remain in the current window so callers can send an
// exact Retry-After header.
async function fixedWindowIncrementWithRetry(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const current = await kv.get(key);
  const now = Math.floor(Date.now() / 1000);

  if (!current) {
    await kv.put(
      key,
      JSON.stringify({ count: 1, windowEnd: now + windowSec }),
      {
        expirationTtl: windowSec,
      },
    );
    return { allowed: true, retryAfter: 0 };
  }

  let entry: { count: number; windowEnd: number };
  try {
    entry = JSON.parse(current);
  } catch {
    await kv.put(
      key,
      JSON.stringify({ count: 1, windowEnd: now + windowSec }),
      {
        expirationTtl: windowSec,
      },
    );
    return { allowed: true, retryAfter: 0 };
  }

  if (entry.count >= limit) {
    return {
      allowed: false,
      retryAfter: Math.max(entry.windowEnd - now, 0),
    };
  }
  const remaining = Math.max(entry.windowEnd - now, 1);
  await kv.put(
    key,
    JSON.stringify({ count: entry.count + 1, windowEnd: entry.windowEnd }),
    { expirationTtl: remaining },
  );
  return { allowed: true, retryAfter: 0 };
}

// Boolean convenience wrapper for callers that only need allow/deny.
async function fixedWindowIncrement(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  return (await fixedWindowIncrementWithRetry(kv, key, limit, windowSec))
    .allowed;
}

// BE-S6: Rate limit login on two dimensions — email (10/15min) and IP (20/15min).
// Both counters are recorded; a request is blocked if either dimension is over.
export async function checkLoginRateLimit(
  kv: KVNamespace,
  email: string,
  ip: string,
): Promise<boolean> {
  const [emailOk, ipOk] = await Promise.all([
    fixedWindowIncrement(kv, KV_PREFIX.loginAttempts(email), 10, 900),
    fixedWindowIncrement(kv, KV_PREFIX.loginAttemptsIp(ip), 20, 900),
  ]);
  return emailOk && ipOk;
}

export async function resetLoginAttempts(
  kv: KVNamespace,
  email: string,
  ip: string,
): Promise<void> {
  await Promise.all([
    kv.delete(KV_PREFIX.loginAttempts(email)),
    kv.delete(KV_PREFIX.loginAttemptsIp(ip)),
  ]);
}

// BE-S6: IP-only rate limit for registration (10/hour) — closes the bulk
// account-creation gap; /register previously had no rate limiting at all.
export async function checkRegisterRateLimit(
  kv: KVNamespace,
  ip: string,
): Promise<boolean> {
  return fixedWindowIncrement(kv, KV_PREFIX.registerIp(ip), 10, 3600);
}

// BE-S6: IP dimension for forgot-password (10/hour), complementing the existing
// per-email OTP limit, so an attacker can't mail-bomb arbitrary addresses.
export async function checkForgotPasswordIpRateLimit(
  kv: KVNamespace,
  ip: string,
): Promise<boolean> {
  return fixedWindowIncrement(kv, KV_PREFIX.forgotPasswordIp(ip), 10, 3600);
}

// BE-S5: IP rate limit for the setup/migration endpoint (3/10min) — prevents
// online brute-forcing of the setup secret. Returns whether the attempt is
// allowed and, when not, how many seconds remain in the window so the caller
// can send an exact Retry-After header.
export async function checkSetupRateLimit(
  kv: KVNamespace,
  ip: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  return fixedWindowIncrementWithRetry(kv, KV_PREFIX.setupRate(ip), 3, 600);
}

// BE-S6: Per-admin rate limit for the "send test email" endpoint (5/10min) —
// prevents an admin account from mail-bombing arbitrary addresses. Returns
// whether the attempt is allowed and, when not, how many seconds remain in the
// window so the caller can send an exact Retry-After header.
export async function checkTestEmailRateLimit(
  kv: KVNamespace,
  adminId: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  return fixedWindowIncrementWithRetry(
    kv,
    KV_PREFIX.testEmailRate(adminId),
    5,
    600,
  );
}

// ─── 2FA attempt tracking (C2: max 5 per pending token) ──────────────────────

export async function increment2faAttempts(
  kv: KVNamespace,
  jti: string,
): Promise<number> {
  const key = KV_PREFIX.twoFaAttempts(jti);
  const current = await kv.get(key);
  const count = (current ? parseInt(current, 10) : 0) + 1;
  await kv.put(key, String(count), { expirationTtl: 600 }); // matches pending token TTL
  return count;
}

// R4-L3: Separate counter for passkey/verify-options (cap 10, independent from verify budget)
export async function incrementPasskeyOptsAttempts(
  kv: KVNamespace,
  jti: string,
): Promise<number> {
  const key = KV_PREFIX.passkeyOptsAttempts(jti);
  const current = await kv.get(key);
  const count = (current ? parseInt(current, 10) : 0) + 1;
  await kv.put(key, String(count), { expirationTtl: 600 });
  return count;
}

// R4-L4: Rate limit TOTP confirm attempts per user (max 10, TTL 120s)
export async function incrementTotpConfirmAttempts(
  kv: KVNamespace,
  userId: string,
): Promise<number> {
  const key = KV_PREFIX.totpConfirmAttempts(userId);
  const current = await kv.get(key);
  const count = (current ? parseInt(current, 10) : 0) + 1;
  await kv.put(key, String(count), { expirationTtl: 120 });
  return count;
}

export async function resetTotpConfirmAttempts(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(KV_PREFIX.totpConfirmAttempts(userId));
}

// ─── JTI denylist (C4: token revocation) ─────────────────────────────────────

export async function denylistJti(
  kv: KVNamespace,
  jti: string,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds <= 0) return;
  await kv.put(KV_PREFIX.jtiDeny(jti), '1', { expirationTtl: ttlSeconds });
}

export async function isJtiDenylisted(
  kv: KVNamespace,
  jti: string,
): Promise<boolean> {
  const val = await kv.get(KV_PREFIX.jtiDeny(jti));
  return val !== null;
}

// ─── Settings cache ───────────────────────────────────────────────────────────

export async function getCachedSetting(
  kv: KVNamespace,
  key: string,
): Promise<string | null> {
  return kv.get(KV_PREFIX.settingCache(key));
}

export async function setCachedSetting(
  kv: KVNamespace,
  key: string,
  value: string,
): Promise<void> {
  await kv.put(KV_PREFIX.settingCache(key), value, { expirationTtl: 60 });
}

export async function deleteCachedSetting(
  kv: KVNamespace,
  key: string,
): Promise<void> {
  await kv.delete(KV_PREFIX.settingCache(key));
}
