import { Hono } from 'hono';
import { tbl } from '../lib/db.js';
import { deleteCachedLink } from '../lib/kv.js';
import { parsePagination } from '../lib/params.js';
import { generateSlug, isReservedSlug, isValidSlug } from '../lib/slug.js';
import { requireAuth } from '../middleware/auth.js';
import type { Env, LinkRow, Variables } from '../types.js';

const links = new Hono<{ Bindings: Env; Variables: Variables }>();

links.use('*', requireAuth);

// ─── Helper: generate unique slug ─────────────────────────────────────────────

async function getUniqueSlug(
  env: Env,
  length = 4,
  maxAttempts = 5,
): Promise<string> {
  if (length > 10)
    throw new Error('Could not generate unique slug after many attempts');
  for (let i = 0; i < maxAttempts; i++) {
    const slug = generateSlug(length);
    const existing = await env.DB.prepare(
      `SELECT 1 FROM ${tbl(env, 'links')} WHERE slug = ?1`,
    )
      .bind(slug)
      .first();
    if (!existing) return slug;
  }
  return getUniqueSlug(env, length + 1, maxAttempts);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/links
// ─────────────────────────────────────────────────────────────────────────────
links.get('/', async (c) => {
  const userId = c.get('userId');
  const { page, limit, offset } = parsePagination(
    c.req.query('page'),
    c.req.query('limit'),
    50,
  );
  const search = c.req.query('search')?.trim() ?? '';

  let query: string;
  let countQuery: string;
  const binds: (string | number)[] = [userId];
  const safe = search.replace(/[%_\\]/g, '\\$&');
  const L = tbl(c.env, 'links');
  const CL = tbl(c.env, 'click_logs');

  if (search) {
    query = `SELECT l.id, l.slug, l.destination_url, l.title, l.expires_at, l.is_active, l.user_seq, l.created_at,
                    (SELECT COUNT(*) FROM ${CL} WHERE link_id = l.id) as click_count
             FROM ${L} l WHERE l.user_id = ?1 AND (l.slug LIKE ?2 ESCAPE '\\' OR l.destination_url LIKE ?2 ESCAPE '\\' OR l.title LIKE ?2 ESCAPE '\\')
             ORDER BY l.created_at DESC LIMIT ?3 OFFSET ?4`;
    countQuery = `SELECT COUNT(*) as n FROM ${L} l WHERE l.user_id = ?1 AND (l.slug LIKE ?2 ESCAPE '\\' OR l.destination_url LIKE ?2 ESCAPE '\\' OR l.title LIKE ?2 ESCAPE '\\')`;
    binds.push(`%${safe}%`, limit, offset);
  } else {
    query = `SELECT l.id, l.slug, l.destination_url, l.title, l.expires_at, l.is_active, l.user_seq, l.created_at,
                    (SELECT COUNT(*) FROM ${CL} WHERE link_id = l.id) as click_count
             FROM ${L} l WHERE l.user_id = ?1 ORDER BY l.created_at DESC LIMIT ?2 OFFSET ?3`;
    countQuery = `SELECT COUNT(*) as n FROM ${L} l WHERE l.user_id = ?1`;
    binds.push(limit, offset);
  }

  const [rows, countRow] = await c.env.DB.batch([
    c.env.DB.prepare(query).bind(...binds),
    c.env.DB.prepare(countQuery).bind(userId, ...(search ? [`%${safe}%`] : [])),
  ]);

  const total = (countRow?.results[0] as { n: number } | undefined)?.n ?? 0;

  return c.json({
    links: rows?.results,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/links
// ─────────────────────────────────────────────────────────────────────────────
links.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req
    .json<{
      destinationUrl: string;
      customSlug?: string;
      title?: string;
      expiryDays?: number | null;
      expiresAt?: number | null;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  if (!body.destinationUrl) {
    return c.json({ error: 'destinationUrl is required' }, 400);
  }

  if (body.destinationUrl.length > 2048) {
    return c.json(
      { error: 'destinationUrl must be 2048 characters or fewer' },
      400,
    );
  }
  if (body.title && body.title.length > 255) {
    return c.json({ error: 'title must be 255 characters or fewer' }, 400);
  }

  try {
    const parsed = new URL(body.destinationUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ error: 'Only http and https URLs are allowed' }, 400);
    }
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  const L = tbl(c.env, 'links');
  let slug: string;
  if (body.customSlug) {
    const customSlug = body.customSlug.trim();
    if (!isValidSlug(customSlug)) {
      return c.json(
        {
          error:
            'Slug must be 1-50 alphanumeric characters, dashes, or underscores',
        },
        400,
      );
    }
    if (isReservedSlug(customSlug)) {
      return c.json({ error: 'This slug is reserved' }, 400);
    }
    const existing = await c.env.DB.prepare(
      `SELECT 1 FROM ${L} WHERE slug = ?1`,
    )
      .bind(customSlug)
      .first();
    if (existing) {
      return c.json({ error: 'This slug is already taken' }, 409);
    }
    slug = customSlug;
  } else {
    slug = await getUniqueSlug(c.env);
  }

  let expiresAt: number | null = null;
  const now = Math.floor(Date.now() / 1000);
  if (body.expiresAt) {
    if (!Number.isSafeInteger(body.expiresAt)) {
      return c.json(
        { error: 'expiresAt must be an integer Unix timestamp' },
        400,
      );
    }
    if (body.expiresAt <= now) {
      return c.json({ error: 'expiresAt must be in the future' }, 400);
    }
    expiresAt = body.expiresAt;
  } else if (body.expiryDays && body.expiryDays > 0) {
    if (body.expiryDays > 3650) {
      return c.json({ error: 'expiryDays must be 3650 or fewer' }, 400);
    }
    expiresAt = now + body.expiryDays * 86400;
  }

  const row = await c.env.DB.prepare(
    `INSERT INTO ${L} (user_id, slug, destination_url, title, expires_at, user_seq)
     VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(user_seq), 0) + 1 FROM ${L} WHERE user_id = ?1))
     RETURNING id, slug, destination_url, title, expires_at, is_active, user_seq, created_at`,
  )
    .bind(userId, slug, body.destinationUrl, body.title ?? null, expiresAt)
    .first<LinkRow>();

  if (!row) return c.json({ error: 'Failed to create link' }, 500);

  return c.json({ link: row }, 201);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/links/:id
// ─────────────────────────────────────────────────────────────────────────────
links.get('/:id', async (c) => {
  const userId = c.get('userId');
  const role = c.get('userRole');
  const id = c.req.param('id');
  const L = tbl(c.env, 'links');

  const whereClause =
    role === 'admin' ? 'WHERE id = ?1' : 'WHERE id = ?1 AND user_id = ?2';
  const binds = role === 'admin' ? [id] : [id, userId];

  const row = await c.env.DB.prepare(`SELECT * FROM ${L} ${whereClause}`)
    .bind(...binds)
    .first<LinkRow>();

  if (!row) return c.json({ error: 'Link not found' }, 404);
  return c.json({ link: row });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/links/:id
// ─────────────────────────────────────────────────────────────────────────────
links.put('/:id', async (c) => {
  const userId = c.get('userId');
  const role = c.get('userRole');
  const id = c.req.param('id');
  const L = tbl(c.env, 'links');

  const existing = await c.env.DB.prepare(
    role === 'admin'
      ? `SELECT * FROM ${L} WHERE id = ?1`
      : `SELECT * FROM ${L} WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(...(role === 'admin' ? [id] : [id, userId]))
    .first<LinkRow>();

  if (!existing) return c.json({ error: 'Link not found' }, 404);

  const body = await c.req
    .json<{
      destinationUrl?: string;
      title?: string;
      isActive?: boolean;
      expiryDays?: number | null;
      expiresAt?: number | null;
      customSlug?: string;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  let newSlug = existing.slug;
  if (body.customSlug !== undefined && body.customSlug !== existing.slug) {
    const customSlug = body.customSlug.trim();
    if (!isValidSlug(customSlug)) {
      return c.json({ error: 'Invalid slug' }, 400);
    }
    if (isReservedSlug(customSlug)) {
      return c.json({ error: 'This slug is reserved' }, 400);
    }
    const conflict = await c.env.DB.prepare(
      `SELECT 1 FROM ${L} WHERE slug = ?1 AND id != ?2`,
    )
      .bind(customSlug, id)
      .first();
    if (conflict) return c.json({ error: 'Slug already taken' }, 409);
    newSlug = customSlug;
  }

  if (body.destinationUrl) {
    if (body.destinationUrl.length > 2048) {
      return c.json(
        { error: 'destinationUrl must be 2048 characters or fewer' },
        400,
      );
    }
    try {
      const parsed = new URL(body.destinationUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return c.json({ error: 'Only http and https URLs are allowed' }, 400);
      }
    } catch {
      return c.json({ error: 'Invalid URL' }, 400);
    }
  }

  if (body.title && body.title.length > 255) {
    return c.json({ error: 'title must be 255 characters or fewer' }, 400);
  }

  let expiresAt = existing.expires_at;
  const now = Math.floor(Date.now() / 1000);
  if (body.expiresAt !== undefined) {
    if (body.expiresAt !== null) {
      if (!Number.isSafeInteger(body.expiresAt)) {
        return c.json(
          { error: 'expiresAt must be an integer Unix timestamp' },
          400,
        );
      }
      if (body.expiresAt <= now) {
        return c.json({ error: 'expiresAt must be in the future' }, 400);
      }
    }
    expiresAt = body.expiresAt;
  } else if (body.expiryDays !== undefined) {
    if (body.expiryDays && body.expiryDays > 3650) {
      return c.json({ error: 'expiryDays must be 3650 or fewer' }, 400);
    }
    expiresAt =
      body.expiryDays && body.expiryDays > 0
        ? now + body.expiryDays * 86400
        : null;
  }

  await c.env.DB.prepare(
    `UPDATE ${L} SET
       slug = ?1, destination_url = ?2, title = ?3, is_active = ?4, expires_at = ?5, updated_at = unixepoch()
     WHERE id = ?6`,
  )
    .bind(
      newSlug,
      body.destinationUrl ?? existing.destination_url,
      body.title !== undefined ? body.title : existing.title,
      body.isActive !== undefined
        ? body.isActive
          ? 1
          : 0
        : existing.is_active,
      expiresAt,
      id,
    )
    .run();

  await deleteCachedLink(c.env.LINKS_KV, existing.slug);
  if (newSlug !== existing.slug) {
    await deleteCachedLink(c.env.LINKS_KV, newSlug);
  }

  const updated = await c.env.DB.prepare(`SELECT * FROM ${L} WHERE id = ?1`)
    .bind(id)
    .first<LinkRow>();

  return c.json({ link: updated });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/links/:id
// ─────────────────────────────────────────────────────────────────────────────
links.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const role = c.get('userRole');
  const id = c.req.param('id');
  const L = tbl(c.env, 'links');

  const existing = await c.env.DB.prepare(
    role === 'admin'
      ? `SELECT slug FROM ${L} WHERE id = ?1`
      : `SELECT slug FROM ${L} WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(...(role === 'admin' ? [id] : [id, userId]))
    .first<Pick<LinkRow, 'slug'>>();

  if (!existing) return c.json({ error: 'Link not found' }, 404);

  await c.env.DB.prepare(`DELETE FROM ${L} WHERE id = ?1`).bind(id).run();
  await deleteCachedLink(c.env.LINKS_KV, existing.slug);

  return c.json({ success: true });
});

export default links;
