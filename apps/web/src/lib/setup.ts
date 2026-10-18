import type { TFunction, TranslationKey } from '@/i18n';
import { isSessionExpiredError } from '../api/client.ts';
import { API_ERROR_CODES } from './apiErrorCodes.ts';

// Pure, testable helpers for the /setup page and the admin "check & upgrade"
// action. Kept free of React so they run under `node --test`; the runtime import
// below is relative (`.ts`) because Node's type stripping does no `@/` alias
// resolution.

// ─── Migration result display ────────────────────────────────────────────────

export type MigrationStatus = 'applied' | 'skipped' | 'error';

// Maps a migration status to the Badge variant shown next to its name.
export const MIGRATION_STATUS_VARIANT = {
  applied: 'success',
  skipped: 'secondary',
  error: 'destructive',
} as const;

// Maps a migration status to its localized label key.
export function migrationStatusLabel(status: MigrationStatus): TranslationKey {
  switch (status) {
    case 'applied':
      return 'setup.statusApplied';
    case 'skipped':
      return 'setup.statusSkipped';
    case 'error':
      return 'setup.statusError';
  }
}

// ─── Error mapping ────────────────────────────────────────────────────────────

export type SetupErrorMsg = {
  key: TranslationKey;
  params?: Record<string, string | number>;
};

// Structural view of what an API error looks like for setup/upgrade.
export interface SetupErrorLike {
  status: number;
  code?: string;
  retryAfter?: number;
  message?: string;
}

// Maps a setup/upgrade error to a localized message. The endpoints return plain
// `{ error }` bodies without a `code`, so status codes drive the mapping. A
// `code`, when the backend does send one, still goes through API_ERROR_CODES so
// future codes localize without a frontend change. Returns null for a
// session-expired error so callers stay quiet (AuthProvider shows the single
// global toast); every other unclassified error falls back to the generic key
// rather than leaking an untranslated backend/network string.
export function resolveSetupError(error: unknown): SetupErrorMsg | null {
  if (isSessionExpiredError(error)) return null;
  if (error && typeof error === 'object') {
    const e = error as SetupErrorLike;
    if (typeof e.code === 'string' && e.code !== '') {
      const key = API_ERROR_CODES[e.code] as TranslationKey | undefined;
      if (key) return { key };
    }
    switch (e.status) {
      case 400:
        return { key: 'setup.errorBadRequest' };
      case 403:
        return { key: 'setup.errorForbidden' };
      case 404:
        return { key: 'setup.errorNotFound' };
      case 429:
        return {
          key: 'setup.errorTooManyRequests',
          params: { seconds: e.retryAfter ?? 0 },
        };
      case 500:
        return { key: 'setup.errorServer' };
    }
  }
  return { key: 'setup.errorGeneric' };
}

// Turns a resolved setup error into its display string, or null when there is
// nothing to show (no error, or a session-expired error handled elsewhere).
export function formatSetupError(
  msg: SetupErrorMsg | null,
  t: TFunction,
): string | null {
  if (!msg) return null;
  return t(msg.key, msg.params);
}
