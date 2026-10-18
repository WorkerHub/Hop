import type { TFunction, TranslationKey } from '@/i18n';
import { isSessionExpiredError } from '../api/client.ts';

// Pure, testable helpers for the admin "send test email" action. Kept free of
// React so they run under `node --test`; the runtime import below is relative
// (`.ts`) because Node's type stripping does no `@/` alias resolution.

export type TestEmailErrorMsg = {
  key: TranslationKey;
  params?: Record<string, string | number>;
};

// Structural view of what a test-email API error looks like.
export interface TestEmailErrorLike {
  status: number;
  retryAfter?: number;
}

// Maps a test-email failure to a localized message. The endpoint returns a
// plain `{ error }` body without a `code`, so the status code drives the
// mapping: 400 is a config/address problem, 429 is rate-limiting (with
// Retry-After seconds), 502 is a send failure, and everything else falls back
// to a generic key rather than leaking an untranslated backend/network string.
// Returns null for a session-expired error so callers stay quiet (AuthProvider
// shows the single global toast).
export function resolveTestEmailError(
  error: unknown,
): TestEmailErrorMsg | null {
  if (isSessionExpiredError(error)) return null;
  if (error && typeof error === 'object') {
    const e = error as TestEmailErrorLike;
    switch (e.status) {
      case 400:
        return { key: 'admin.testEmailErrorBadRequest' };
      case 429:
        return {
          key: 'admin.testEmailErrorTooManyRequests',
          params: { seconds: e.retryAfter ?? 0 },
        };
      case 502:
        return { key: 'admin.testEmailErrorSendFailed' };
    }
  }
  return { key: 'admin.testEmailErrorGeneric' };
}

// Turns a resolved test-email error into its display string, or null when there
// is nothing to show (no error, or a session-expired error handled elsewhere).
export function formatTestEmailError(
  msg: TestEmailErrorMsg | null,
  t: TFunction,
): string | null {
  if (!msg) return null;
  return t(msg.key, msg.params);
}
