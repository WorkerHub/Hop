import { toast } from 'sonner';
import { isSessionExpiredError } from '@/api/client';

// #6: an expired session fails every in-flight request at once. AuthProvider
// shows a single "Session expired" toast, so per-request error toasts must stay
// quiet — otherwise the user sees the same message once per request.
export function toastApiError(error: unknown, fallback: string): void {
  if (isSessionExpiredError(error)) return;
  toast.error(
    error instanceof Error && error.message ? error.message : fallback,
  );
}
