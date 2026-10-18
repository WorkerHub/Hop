import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { tbl } from './lib/db.js';
import { apiError } from './lib/errors.js';
import { getCachedSetting, setCachedSetting } from './lib/kv.js';
import { API_CSP, securityHeaders, spaCsp } from './lib/security.js';
import { RESERVED_SLUGS } from './lib/slug.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';
import authRoutes from './routes/auth.js';
import linksRoutes from './routes/links.js';
import redirectHandler from './routes/redirect.js';
import setupRoutes from './routes/setup.js';
import type { Env, Variables } from './types.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Request ID + structured error handling (BE-Q3) ───────────────────────────
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

// BE-Q3: log unhandled errors with structured fields (path, error name,
// requestId) and never leak internal details to the client.
app.onError((err, c) => {
  console.error(
    JSON.stringify({
      level: 'error',
      path: c.req.path,
      method: c.req.method,
      error: err instanceof Error ? err.name : typeof err,
      requestId: c.get('requestId'),
    }),
  );
  return apiError(c, 500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error');
});

// ─── Security headers ─────────────────────────────────────────────────────────
app.use('/api/*', async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(
    securityHeaders(c.env.APP_URL, API_CSP),
  )) {
    c.header(k, v);
  }
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use('/api/*', async (c, next) => {
  const handler = cors({
    origin: (origin) => {
      // Trim APP_URL so a stray leading/trailing space in the variable doesn't
      // make the allowed-origin list miss every real Origin (which is also why
      // HSTS went missing in production).
      const allowed = [c.env.APP_URL.trim()];
      // BE-S10: allow the Vite dev-server origins only when the Worker is reached
      // over plain http on a loopback host (i.e. wrangler dev). A deployed Worker
      // is served from a real hostname, so neither condition holds in production.
      const url = new URL(c.req.url);
      const isLoopback =
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '::1';
      if (url.protocol === 'http:' && isLoopback) {
        allowed.push('http://localhost:5173', 'http://localhost:4173');
      }
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
  });
  return handler(c, next);
});

// ─── Public config endpoint ───────────────────────────────────────────────────
app.get('/api/config', async (c) => {
  const [appNameCached, regCached] = await Promise.all([
    getCachedSetting(c.env.LINKS_KV, 'app_name'),
    getCachedSetting(c.env.LINKS_KV, 'registration_enabled'),
  ]);

  let appName: string;
  if (appNameCached !== null) {
    appName = appNameCached;
  } else {
    const row = await c.env.DB.prepare(
      `SELECT value FROM ${tbl(c.env, 'settings')} WHERE key = 'app_name'`,
    ).first<{ value: string }>();
    appName = row?.value ?? c.env.APP_NAME ?? 'ShortLink';
    if (row?.value)
      await setCachedSetting(c.env.LINKS_KV, 'app_name', row.value);
  }

  let registrationEnabled: boolean;
  if (regCached !== null) {
    registrationEnabled = regCached === 'true';
  } else {
    const row = await c.env.DB.prepare(
      `SELECT value FROM ${tbl(c.env, 'settings')} WHERE key = 'registration_enabled'`,
    ).first<{ value: string }>();
    const val = row?.value ?? 'false';
    await setCachedSetting(c.env.LINKS_KV, 'registration_enabled', val);
    registrationEnabled = val === 'true';
  }

  return c.json({ appName, registrationEnabled });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.route('/api/auth', authRoutes);
app.route('/api/links', linksRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api/admin', adminRoutes);

// ─── Setup / migration endpoint ───────────────────────────────────────────────
// Mounted at /api/setup to match the rest of the public API; /setup is kept as a
// backward-compatible alias for callers that predate the /api prefix.
app.route('/api/setup', setupRoutes);
app.route('/setup', setupRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// ─── Unmatched API requests ───────────────────────────────────────────────────
// Any /api/* request that no route above handled (unknown path, or a known path
// with the wrong HTTP method — e.g. GET on a POST-only endpoint) must return a
// JSON 404, never the SPA's index.html. The SPA fallback below stays for
// non-/api paths only.
app.all('/api/*', (c) => {
  return apiError(c, 404, 'NOT_FOUND', 'Not found');
});

// ─── Short link redirect ───────────────────────────────────────────────────────
const SPA_PREFIXES = new Set([...RESERVED_SLUGS].map((s) => `/${s}`));

app.get('/:slug', async (c, next) => {
  const slug = c.req.param('slug');
  if (SPA_PREFIXES.has(`/${slug}`)) {
    return next();
  }
  // Static files (e.g. logo.svg, favicon.ico) — slugs never contain dots
  if (slug.includes('.')) {
    return next();
  }
  return redirectHandler.fetch(c.req.raw, c.env, c.executionCtx);
});

// Fallback — forward all unmatched requests to Workers Assets (SPA + static files)
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.url);
  // BE-S11: the /api/* middleware above does not cover SPA/static responses, so
  // attach security headers (including a Vite-compatible CSP) here.
  const headers = new Headers(res.headers);
  // BE-S13: give HTML responses a fresh nonce so Cloudflare's JavaScript
  // Detections (Bot Fight Mode) can stamp it onto the inline challenge script it
  // injects, instead of being blocked by script-src. Static assets get no nonce
  // (meaningless there), so the CSP stays unchanged for them.
  const nonce = (headers.get('content-type') ?? '').includes('text/html')
    ? crypto.randomUUID()
    : undefined;
  for (const [k, v] of Object.entries(
    securityHeaders(c.env.APP_URL, spaCsp(nonce)),
  )) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
});

export { app };

export default {
  fetch: app.fetch,

  // L-2: Nightly cleanup of expired rows (cron: "0 3 * * *")
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM ${tbl(env, 'verifications')} WHERE expires_at < unixepoch()`,
      ),
      env.DB.prepare(
        `DELETE FROM ${tbl(env, 'totp_used')} WHERE used_at < unixepoch() - 90`,
      ),
    ]);
  },
} satisfies ExportedHandler<Env>;
