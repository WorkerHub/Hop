import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Stable, machine-readable error codes so the frontend can localize error
// messages instead of rendering the backend's English prose verbatim. The
// `error` field is kept for backward compatibility with older clients; new
// clients map `code` through i18n and fall back to `error` when the code is
// unknown.
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  error: string,
) {
  return c.json({ error, code }, status);
}
