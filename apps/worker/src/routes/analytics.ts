import { Hono } from 'hono';
import { tbl } from '../lib/db.js';
import { parseIntParam } from '../lib/params.js';
import { requireAuth } from '../middleware/auth.js';
import type { Env, LinkRow, Variables } from '../types.js';

const analytics = new Hono<{ Bindings: Env; Variables: Variables }>();

analytics.use('*', requireAuth);

// ─── Helper: check link ownership ────────────────────────────────────────────

async function getLinkForUser(
  env: Pick<Env, 'DB' | 'TABLE_PREFIX'>,
  linkId: string,
  userId: string,
  role: string,
): Promise<LinkRow | null> {
  const L = tbl(env, 'links');
  if (role === 'admin') {
    return env.DB.prepare(`SELECT * FROM ${L} WHERE id = ?1`)
      .bind(linkId)
      .first<LinkRow>();
  }
  return env.DB.prepare(`SELECT * FROM ${L} WHERE id = ?1 AND user_id = ?2`)
    .bind(linkId, userId)
    .first<LinkRow>();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/summary
//   Query params: days=30 (max 365)
//   Returns aggregated stats for all links owned by the current user.
// ─────────────────────────────────────────────────────────────────────────────
analytics.get('/summary', async (c) => {
  const userId = c.get('userId');
  const days = parseIntParam(c.req.query('days'), 30, 1, 365);
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;

  const L = tbl(c.env, 'links');
  const CL = tbl(c.env, 'click_logs');

  const [
    totalResult,
    byDayResult,
    topLinksResult,
    byCountryResult,
    byDeviceResult,
    byBrowserResult,
    byOsResult,
    byRefResult,
  ] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) as total_clicks FROM ${CL} cl JOIN ${L} l ON cl.link_id = l.id WHERE l.user_id = ?1 AND cl.created_at >= ?2`,
    ).bind(userId, since),

    c.env.DB.prepare(
      `SELECT date(datetime(cl.created_at, 'unixepoch')) as day, COUNT(*) as clicks
         FROM ${CL} cl JOIN ${L} l ON cl.link_id = l.id
         WHERE l.user_id = ?1 AND cl.created_at >= ?2
         GROUP BY day ORDER BY day ASC`,
    ).bind(userId, since),

    c.env.DB.prepare(
      `SELECT l.id, l.slug, l.title, COUNT(*) as clicks
         FROM ${CL} cl JOIN ${L} l ON cl.link_id = l.id
         WHERE l.user_id = ?1 AND cl.created_at >= ?2
         GROUP BY l.id ORDER BY clicks DESC LIMIT 10`,
    ).bind(userId, since),

    c.env.DB.prepare(
      `SELECT country, COUNT(*) as clicks FROM ${CL} cl JOIN ${L} l ON cl.link_id = l.id
         WHERE l.user_id = ?1 AND cl.created_at >= ?2 AND country IS NOT NULL
         GROUP BY country ORDER BY clicks DESC LIMIT 50`,
    ).bind(userId, since),

    c.env.DB.prepare(
      `SELECT device_type, COUNT(*) as clicks FROM ${CL} cl JOIN ${L} l ON cl.link_id = l.id
         WHERE l.user_id = ?1 AND cl.created_at >= ?2 AND device_type IS NOT NULL
         GROUP BY device_type ORDER BY clicks DESC`,
    ).bind(userId, since),

    c.env.DB.prepare(
      `SELECT browser, COUNT(*) as clicks FROM ${CL} cl JOIN ${L} l ON cl.link_id = l.id
         WHERE l.user_id = ?1 AND cl.created_at >= ?2 AND browser IS NOT NULL
         GROUP BY browser ORDER BY clicks DESC LIMIT 10`,
    ).bind(userId, since),

    c.env.DB.prepare(
      `SELECT os, COUNT(*) as clicks FROM ${CL} cl JOIN ${L} l ON cl.link_id = l.id
         WHERE l.user_id = ?1 AND cl.created_at >= ?2 AND os IS NOT NULL
         GROUP BY os ORDER BY clicks DESC LIMIT 10`,
    ).bind(userId, since),

    c.env.DB.prepare(
      `SELECT referer, COUNT(*) as clicks FROM ${CL} cl JOIN ${L} l ON cl.link_id = l.id
         WHERE l.user_id = ?1 AND cl.created_at >= ?2 AND referer IS NOT NULL
         GROUP BY referer ORDER BY clicks DESC LIMIT 20`,
    ).bind(userId, since),
  ]);

  const totalClicks =
    (totalResult?.results[0] as { total_clicks: number } | undefined)
      ?.total_clicks ?? 0;

  return c.json({
    stats: {
      totalClicks,
      days,
      topLinks: topLinksResult?.results,
      timeline: byDayResult?.results,
      countries: byCountryResult?.results,
      devices: byDeviceResult?.results,
      browsers: byBrowserResult?.results,
      os: byOsResult?.results,
      referrers: byRefResult?.results,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/:linkId
//   Query params: days=7 (default 30, max 365)
// ─────────────────────────────────────────────────────────────────────────────
analytics.get('/:linkId', async (c) => {
  const userId = c.get('userId');
  const role = c.get('userRole');
  const linkId = c.req.param('linkId');

  const link = await getLinkForUser(c.env, linkId, userId, role);
  if (!link) return c.json({ error: 'Link not found' }, 404);

  const days = parseIntParam(c.req.query('days'), 30, 1, 365);
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;

  const CL = tbl(c.env, 'click_logs');

  const [
    totalResult,
    byDayResult,
    byCountryResult,
    byDeviceResult,
    byBrowserResult,
    byOsResult,
    byRefResult,
  ] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) as total_clicks FROM ${CL} WHERE link_id = ?1 AND created_at >= ?2`,
    ).bind(linkId, since),

    c.env.DB.prepare(
      `SELECT date(datetime(created_at, 'unixepoch')) as day, COUNT(*) as clicks
         FROM ${CL} WHERE link_id = ?1 AND created_at >= ?2
         GROUP BY day ORDER BY day ASC`,
    ).bind(linkId, since),

    c.env.DB.prepare(
      `SELECT country, COUNT(*) as clicks FROM ${CL}
         WHERE link_id = ?1 AND created_at >= ?2 AND country IS NOT NULL
         GROUP BY country ORDER BY clicks DESC LIMIT 50`,
    ).bind(linkId, since),

    c.env.DB.prepare(
      `SELECT device_type, COUNT(*) as clicks FROM ${CL}
         WHERE link_id = ?1 AND created_at >= ?2 AND device_type IS NOT NULL
         GROUP BY device_type ORDER BY clicks DESC`,
    ).bind(linkId, since),

    c.env.DB.prepare(
      `SELECT browser, COUNT(*) as clicks FROM ${CL}
         WHERE link_id = ?1 AND created_at >= ?2 AND browser IS NOT NULL
         GROUP BY browser ORDER BY clicks DESC LIMIT 10`,
    ).bind(linkId, since),

    c.env.DB.prepare(
      `SELECT os, COUNT(*) as clicks FROM ${CL}
         WHERE link_id = ?1 AND created_at >= ?2 AND os IS NOT NULL
         GROUP BY os ORDER BY clicks DESC LIMIT 10`,
    ).bind(linkId, since),

    c.env.DB.prepare(
      `SELECT referer, COUNT(*) as clicks FROM ${CL}
         WHERE link_id = ?1 AND created_at >= ?2 AND referer IS NOT NULL
         GROUP BY referer ORDER BY clicks DESC LIMIT 20`,
    ).bind(linkId, since),
  ]);

  const totalClicks =
    (totalResult?.results[0] as { total_clicks: number } | undefined)
      ?.total_clicks ?? 0;

  return c.json({
    link: {
      id: link.id,
      slug: link.slug,
      destinationUrl: link.destination_url,
      title: link.title,
      createdAt: link.created_at,
      expiresAt: link.expires_at,
    },
    stats: {
      totalClicks,
      days,
      timeline: byDayResult?.results,
      countries: byCountryResult?.results,
      devices: byDeviceResult?.results,
      browsers: byBrowserResult?.results,
      os: byOsResult?.results,
      referrers: byRefResult?.results,
    },
  });
});

export default analytics;
