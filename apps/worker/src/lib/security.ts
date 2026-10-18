// Security headers applied to API and SPA (Workers Assets) responses.

// CSP for JSON API responses — no scripts/styles at all.
export const API_CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'";

// HSTS policy applied to HTTPS responses (API, SPA, and short-link redirects).
export const HSTS = 'max-age=63072000; includeSubDomains';

// CSP for the Vite-built SPA. Kept deliberately permissive where the build
// requires it:
//   - script-src 'unsafe-eval': recharts (via decimal.js) and qrcode call
//     `Function("return this")()` at module init, so omitting it breaks those
//     pages (verified by grepping dist/assets/*.js).
//   - style-src 'unsafe-inline': React/recharts set inline style attributes.
//   - img-src data:: the TOTP QR code is rendered from a data: URL.
//
// `nonce`, when provided, is appended to script-src so Cloudflare's JavaScript
// Detections (Bot Fight Mode) can inject its inline challenge snippet. Cloudflare
// parses the nonce out of this CSP response header and stamps it onto the inline
// script it injects, which keeps bot detection working without loosening
// script-src to 'unsafe-inline'. The SPA itself ships only external module
// scripts (Vite output), so it needs no nonce in its own markup.
export function spaCsp(nonce?: string): string {
  const nonceDirective = nonce ? ` 'nonce-${nonce}'` : '';
  return `default-src 'self'; script-src 'self' 'unsafe-eval'${nonceDirective}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
}

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
  // Normalize APP_URL before checking its scheme: a stray leading/trailing space
  // would otherwise silently suppress HSTS (and break CORS origin matching) even
  // though the variable is "correct" apart from the whitespace.
  if (appUrl.trim().startsWith('https')) {
    headers['Strict-Transport-Security'] = HSTS;
  }
  return headers;
}
