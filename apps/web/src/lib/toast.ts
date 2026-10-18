import { toast } from 'sonner';
import { ApiRequestError, isSessionExpiredError } from '@/api/client';
import type { TFunction, TranslationKey } from '@/i18n';
import { API_ERROR_CODES } from './apiErrorCodes';

// Resolve the message to show for an API error: a localized string when the
// error carries a known code, otherwise the backend's original `error` text, or
// the caller's `fallback` when neither is available. Returns null for a
// session-expired error so callers stay quiet (AuthProvider shows one toast).
export function resolveApiError(
  error: unknown,
  t: TFunction,
  fallback: string,
): string | null {
  if (isSessionExpiredError(error)) return null;
  const code = error instanceof ApiRequestError ? error.code : undefined;
  if (code) {
    const key = API_ERROR_CODES[code] as TranslationKey | undefined;
    if (key) return t(key);
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

// #6: an expired session fails every in-flight request at once. AuthProvider
// shows a single "Session expired" toast, so per-request error toasts must stay
// quiet — otherwise the user sees the same message once per request.
export function toastApiError(
  error: unknown,
  fallback: string,
  t: TFunction,
): void {
  const message = resolveApiError(error, t, fallback);
  if (message === null) return;
  toast.error(message);
}
