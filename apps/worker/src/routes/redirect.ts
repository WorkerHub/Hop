import { Hono } from 'hono';
import { tbl } from '../lib/db.js';
import { getCachedLink, setCachedLink } from '../lib/kv.js';
import { HSTS } from '../lib/security.js';
import { parseUA } from '../lib/ua.js';
import type { CachedLink, Env, LinkRow, Variables } from '../types.js';

const redirect = new Hono<{ Bindings: Env; Variables: Variables }>();

// BE-S13: redirect responses carry the minimal security headers that matter on
// a 302. CSP / X-Content-Type-Options / X-Frame-Options are skipped — the body
// is empty so there is nothing to sniff, script, or frame. Referrer-Policy:
// no-referrer stops the short-link origin leaking as the Referer to the
// destination; HSTS (on https) hardens first-visit downgrade, complementing
// Cloudflare's Always Use HTTPS.
function redirectHeaders(
  appUrl: string,
  location: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
  if (appUrl.startsWith('https')) {
    headers['Strict-Transport-Security'] = HSTS;
  }
  return headers;
}

redirect.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  // ── 1. KV fast path ────────────────────────────────────────────────────────
  let linkData: CachedLink | null = await getCachedLink(c.env.LINKS_KV, slug);

  // ── 2. D1 fallback ─────────────────────────────────────────────────────────
  if (!linkData) {
    const row = await c.env.DB.prepare(
      `SELECT id, destination_url, is_active, expires_at FROM ${tbl(c.env, 'links')} WHERE slug = ?1 LIMIT 1`,
    )
      .bind(slug)
      .first<
        Pick<LinkRow, 'id' | 'destination_url' | 'is_active' | 'expires_at'>
      >();

    if (!row) {
      return new Response(null, {
        status: 302,
        headers: redirectHeaders(c.env.APP_URL, `${c.env.APP_URL}/404`),
      });
    }

    linkData = {
      url: row.destination_url,
      linkId: row.id,
      isActive: row.is_active,
      expiresAt: row.expires_at,
    };

    if (row.is_active) {
      await setCachedLink(c.env.LINKS_KV, slug, linkData);
    }
  }

  // ── 3. Validate ────────────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);

  if (!linkData.isActive) {
    return new Response(null, {
      status: 302,
      headers: redirectHeaders(c.env.APP_URL, `${c.env.APP_URL}/404`),
    });
  }

  if (linkData.expiresAt !== null && linkData.expiresAt <= now) {
    return new Response(null, {
      status: 302,
      headers: redirectHeaders(c.env.APP_URL, `${c.env.APP_URL}/404`),
    });
  }

  // ── 4. Async click logging (non-blocking) ──────────────────────────────────
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const ua = (c.req.header('user-agent') ?? '').slice(0, 512) || null;
  const referer = (c.req.header('referer') ?? '').slice(0, 2048) || null;
  const cf = c.req.raw.cf as Record<string, unknown> | undefined;
  const country = (cf?.country as string) ?? null;
  const city = (cf?.city as string) ?? null;
  const { deviceType, browser, os } = parseUA(ua);
  const linkId = linkData.linkId;

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.DB.prepare(
          `INSERT INTO ${tbl(c.env, 'click_logs')}
             (link_id, ip_address, user_agent, referer, country, city, device_type, browser, os)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
          .bind(linkId, ip, ua, referer, country, city, deviceType, browser, os)
          .run();
      } catch {
        // Analytics failure must never affect redirect
      }
    })(),
  );

  // ── 5. Redirect ────────────────────────────────────────────────────────────
  return new Response(null, {
    status: 302,
    headers: redirectHeaders(c.env.APP_URL, linkData.url),
  });
});

export default redirect;
