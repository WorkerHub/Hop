import { Hono } from 'hono';
import { constantTimeEqual } from '../lib/crypto.js';
import { tbl } from '../lib/db.js';
import { checkSetupRateLimit } from '../lib/kv.js';
import {
  runMigrations,
  TablePrefixConflictError,
} from '../lib/migrations-runner.js';
import type { Env, Variables } from '../types.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── GET /api/setup/state ────────────────────────────────────────────────────
// Public and unauthenticated: only reports whether the setup page is enabled,
// leaking nothing else (not whether the database is initialised, its schema, or
// its version). A missing settings table (database not yet initialised) and a
// missing row both mean the default: enabled. Registered before the GET '/*'
// 405 fallback below so it is not swallowed by it.
app.get('/state', async (c) => {
  let value: string | null = null;
  try {
    const row = await c.env.DB.prepare(
      `SELECT value FROM ${tbl(c.env, 'settings')} WHERE key = 'setup_page_enabled'`,
    ).first<{ value: string }>();
    value = row?.value ?? null;
  } catch {
    // settings table does not exist yet — the database has not been initialised
  }
  return c.json({ enabled: value !== '0' });
});

// ─── GET /api/setup/* (legacy) ───────────────────────────────────────────────
// The old GET /api/setup/:secret form put the secret in the URL (history, logs,
// Referer). It never initialises anything now; it only points callers at the
// POST form.
app.get('/*', (c) =>
  c.json(
    {
      error:
        'Use POST /api/setup with a JSON body {"secret": "<SETUP_SECRET>"}.',
    },
    405,
    { Allow: 'POST' },
  ),
);

// ─── POST /api/setup ─────────────────────────────────────────────────────────
app.post('/', async (c) => {
  // Rate-limit by source IP before anything else — including the secret
  // comparison — so a wrong secret cannot be brute-forced unthrottled. Success
  // and failure both count.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { allowed, retryAfter } = await checkSetupRateLimit(c.env.LINKS_KV, ip);
  if (!allowed) {
    return c.json({ error: 'Too many setup attempts. Try again later.' }, 429, {
      'Retry-After': String(retryAfter),
    });
  }

  const expected = c.env.SETUP_SECRET;
  if (!expected || expected.trim() === '') {
    return c.json(
      { error: 'SETUP_SECRET is not configured on this Worker.' },
      500,
    );
  }

  // Primary channel: a JSON body {"secret": "<SETUP_SECRET>"}. For backward
  // compatibility with callers that predate the JSON body, an empty body falls
  // back to the X-Setup-Secret header.
  const raw = await c.req.text();
  let provided: string;
  if (raw.trim() === '') {
    provided = c.req.header('X-Setup-Secret') ?? '';
  } else {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json(
        { error: 'A JSON body {"secret": "<SETUP_SECRET>"} is required.' },
        400,
      );
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json(
        { error: 'A JSON body {"secret": "<SETUP_SECRET>"} is required.' },
        400,
      );
    }
    const secret = (body as { secret?: unknown }).secret;
    if (typeof secret !== 'string' || secret.length === 0) {
      return c.json(
        { error: 'A JSON body {"secret": "<SETUP_SECRET>"} is required.' },
        400,
      );
    }
    provided = secret;
  }

  // Constant-time comparison so neither the content nor the length of the
  // secret leaks through timing.
  if (!constantTimeEqual(provided, expected)) {
    return c.json({ error: 'Invalid setup secret.' }, 403);
  }

  try {
    return c.json(await runMigrations(c.env));
  } catch (err) {
    if (err instanceof TablePrefixConflictError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

export default app;
