// Security headers applied to API and SPA (Workers Assets) responses.

// CSP for JSON API responses — no scripts/styles at all.
export const API_CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'";

// CSP for the Vite-built SPA. Kept deliberately permissive where the build
// requires it:
//   - script-src 'unsafe-eval': recharts (via decimal.js) and qrcode call
//     `Function("return this")()` at module init, so omitting it breaks those
//     pages (verified by grepping dist/assets/*.js).
//   - style-src 'unsafe-inline': React/recharts set inline style attributes.
//   - img-src data:: the TOTP QR code is rendered from a data: URL.
export const SPA_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export function securityHeaders(
  appUrl: string,
  csp: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': csp,
  };
  if (appUrl.startsWith('https')) {
    headers['Strict-Transport-Security'] =
      'max-age=63072000; includeSubDomains';
  }
  return headers;
}
