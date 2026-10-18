import type { TFunction, TranslationKey } from '@/i18n';
import { API_ERROR_CODES } from './apiErrorCodes.ts';

// A setup/upgrade error, resolved either to a localized message key (with
// optional interpolation params) or to a raw fallback string — the backend's
// own `error` text when no mapping applies.

export type SetupErrorMsg =
  | {
      kind: 'i18n';
      key: TranslationKey;
      params?: Record<string, string | number>;
    }
  | { kind: 'raw'; message: string };

// Structural view of what an API error looks like for setup/upgrade, so this
// helper needs no runtime import of `@/api/client` and can be unit-tested with
// `node --test` (Node's type stripping does no `@/` alias resolution).
export interface SetupErrorLike {
  status: number;
  code?: string;
  retryAfter?: number;
  message?: string;
}

// Maps a setup/upgrade error to a display message. The endpoints return plain
// `{ error }` bodies without a `code`, so status codes drive the mapping. A
// `code`, when the backend does send one, still goes through API_ERROR_CODES so
// future codes localize without a frontend change; an unknown code falls through
// to the status-based mapping, and an unmatched status to the raw text.
export function resolveSetupError(error: unknown): SetupErrorMsg {
  if (error && typeof error === 'object') {
    const e = error as SetupErrorLike;
    if (typeof e.code === 'string' && e.code !== '') {
      const key = API_ERROR_CODES[e.code] as TranslationKey | undefined;
      if (key) return { kind: 'i18n', key };
    }
    switch (e.status) {
      case 400:
        return { kind: 'i18n', key: 'setup.errorBadRequest' };
      case 403:
        return { kind: 'i18n', key: 'setup.errorForbidden' };
      case 404:
        return { kind: 'i18n', key: 'setup.errorNotFound' };
      case 429:
        return {
          kind: 'i18n',
          key: 'setup.errorTooManyRequests',
          params: { seconds: e.retryAfter ?? 0 },
        };
      case 500:
        return { kind: 'i18n', key: 'setup.errorServer' };
    }
  }
  const message =
    error instanceof Error && error.message ? error.message : undefined;
  if (message) return { kind: 'raw', message };
  return { kind: 'i18n', key: 'setup.errorGeneric' };
}

// Turns a resolved setup error into its display string (localized key, or the
// backend's raw message), or null when there is no error to show.
export function formatSetupError(
  msg: SetupErrorMsg | null,
  t: TFunction,
): string | null {
  if (!msg) return null;
  return msg.kind === 'i18n' ? t(msg.key, msg.params) : msg.message;
}
