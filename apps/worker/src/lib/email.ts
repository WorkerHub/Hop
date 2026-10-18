import type { Env } from '../types.js';
import { tbl } from './db.js';
import { getCachedSetting, setCachedSetting } from './kv.js';
import { sendViaSMTP } from './smtp.js';

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

// Thrown when the selected provider's required settings are missing. Callers
// distinguish this from an upstream send failure via `instanceof` rather than
// matching the message text — an SMTP server reply can itself contain the words
// "not configured" (e.g. "554 Server not configured for mail"), which a
// substring check would misclassify as a configuration error.
export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}

// Read a setting from KV cache → DB, then populate the cache on a miss.
async function getSetting(env: Env, key: string): Promise<string> {
  const cached = await getCachedSetting(env.LINKS_KV, key);
  if (cached !== null) return cached;

  const row = await env.DB.prepare(
    `SELECT value FROM ${tbl(env, 'settings')} WHERE key = ?1`,
  )
    .bind(key)
    .first<{ value: string }>();
  const value = row?.value ?? '';
  await setCachedSetting(env.LINKS_KV, key, value);
  return value;
}

export async function sendEmail(
  env: Env,
  payload: EmailPayload,
): Promise<void> {
  const provider = await getSetting(env, 'email_provider');

  if (provider === 'smtp') {
    const [host, portStr, user, pass, from] = await Promise.all([
      getSetting(env, 'smtp_host'),
      getSetting(env, 'smtp_port'),
      getSetting(env, 'smtp_user'),
      getSetting(env, 'smtp_pass'),
      getSetting(env, 'smtp_from'),
    ]);

    if (!host || !from) {
      throw new EmailConfigError(
        'SMTP is selected as email provider but smtp_host or smtp_from is not configured',
      );
    }

    const port = parseInt(portStr, 10) || 587;

    await sendViaSMTP(
      { host, port, user, pass, from },
      payload.to,
      payload.subject,
      payload.html,
    );
    return;
  }

  // Default: Resend — all config read from settings table
  const [apiKey, fromDomain, fromName] = await Promise.all([
    getSetting(env, 'resend_api_key'),
    getSetting(env, 'email_from_domain'),
    getSetting(env, 'email_from_name'),
  ]);

  if (!apiKey || !fromDomain) {
    throw new EmailConfigError(
      'Resend is selected as email provider but resend_api_key or email_from_domain is not configured in admin settings',
    );
  }

  // BE-R1: Abort the fetch if Resend doesn't respond within 10s so registration
  // / reset flows don't hang on a stalled upstream.
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <noreply@${fromDomain}>`,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    // BE-R2: don't fold the upstream response body into the error — it can echo
    // SMTP/credential configuration. Log a redacted summary (status only) and
    // throw a generic error so nothing sensitive reaches the client or the logs.
    console.error('sendEmail failed', {
      provider: 'resend',
      status: res.status,
    });
    throw new Error(`Resend request failed with status ${res.status}`);
  }
}

// M-1: Escape HTML special characters so a malicious app_name cannot inject markup.
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function resetPasswordEmailHtml(appName: string, code: string): string {
  const safeApp = escHtml(appName);
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
  <h2 style="color:#1a1a1a">${safeApp} — Password Reset</h2>
  <p style="color:#444;font-size:15px">You requested a password reset. Enter the code below to set a new password:</p>
  <div style="background:#f4f4f5;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
    <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1a1a1a">${code}</span>
  </div>
  <p style="color:#888;font-size:13px">This code expires in 10 minutes. If you did not request this, you can safely ignore this email.</p>
</body>
</html>
  `.trim();
}

export function verifyEmailHtml(appName: string, code: string): string {
  const safeApp = escHtml(appName);
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
  <h2 style="color:#1a1a1a">${safeApp} — Verify your email</h2>
  <p style="color:#444;font-size:15px">Enter the code below to verify your email address and activate your account:</p>
  <div style="background:#f4f4f5;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
    <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1a1a1a">${code}</span>
  </div>
  <p style="color:#888;font-size:13px">This code expires in 10 minutes. If you did not create an account, you can safely ignore this email.</p>
</body>
</html>
  `.trim();
}

export function otpEmailHtml(appName: string, code: string): string {
  const safeApp = escHtml(appName);
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
  <h2 style="color:#1a1a1a">${safeApp} — Verification Code</h2>
  <p style="color:#444;font-size:15px">Your one-time verification code is:</p>
  <div style="background:#f4f4f5;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
    <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1a1a1a">${code}</span>
  </div>
  <p style="color:#888;font-size:13px">This code expires in 10 minutes. Do not share it with anyone.</p>
</body>
</html>
  `.trim();
}

export function testEmailHtml(
  appName: string,
  sentAt: Date = new Date(),
): string {
  const safeApp = escHtml(appName);
  const safeTime = escHtml(sentAt.toISOString());
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
  <h2 style="color:#1a1a1a">${safeApp} — Test Email</h2>
  <p style="color:#444;font-size:15px">这是一封测试邮件，说明邮件配置可用。</p>
  <p style="color:#888;font-size:13px">Sent at ${safeTime}</p>
</body>
</html>
  `.trim();
}
