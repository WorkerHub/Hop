import { Hono } from 'hono';
import { tbl } from '../lib/db.js';
import { apiError } from '../lib/errors.js';
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
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');

  if (!body.destinationUrl) {
    return apiError(
      c,
      400,
      'DESTINATION_URL_REQUIRED',
      'destinationUrl is required',
    );
  }

  if (body.destinationUrl.length > 2048) {
    return apiError(
      c,
      400,
      'DESTINATION_URL_TOO_LONG',
      'destinationUrl must be 2048 characters or fewer',
    );
  }
  if (body.title && body.title.length > 255) {
    return apiError(
      c,
      400,
      'TITLE_TOO_LONG',
      'title must be 255 characters or fewer',
    );
  }

  try {
    const parsed = new URL(body.destinationUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return apiError(
        c,
        400,
        'ONLY_HTTP_HTTPS_ALLOWED',
        'Only http and https URLs are allowed',
      );
    }
  } catch {
    return apiError(c, 400, 'INVALID_URL', 'Invalid URL');
  }

  const L = tbl(c.env, 'links');
  let slug: string;
  if (body.customSlug) {
    const customSlug = body.customSlug.trim();
    if (!isValidSlug(customSlug)) {
      return apiError(
        c,
        400,
        'INVALID_SLUG',
        'Slug must be 1-50 alphanumeric characters, dashes, or underscores',
      );
    }
    if (isReservedSlug(customSlug)) {
      return apiError(c, 400, 'SLUG_RESERVED', 'This slug is reserved');
    }
    const existing = await c.env.DB.prepare(
      `SELECT 1 FROM ${L} WHERE slug = ?1`,
    )
      .bind(customSlug)
      .first();
    if (existing) {
      return apiError(c, 409, 'SLUG_TAKEN', 'This slug is already taken');
    }
    slug = customSlug;
  } else {
    slug = await getUniqueSlug(c.env);
  }

  let expiresAt: number | null = null;
  const now = Math.floor(Date.now() / 1000);
  if (body.expiresAt) {
    if (!Number.isSafeInteger(body.expiresAt)) {
      return apiError(
        c,
        400,
        'EXPIRES_AT_INVALID',
        'expiresAt must be an integer Unix timestamp',
      );
    }
    if (body.expiresAt <= now) {
      return apiError(
        c,
        400,
        'EXPIRES_AT_IN_PAST',
        'expiresAt must be in the future',
      );
    }
    expiresAt = body.expiresAt;
  } else if (body.expiryDays && body.expiryDays > 0) {
    if (body.expiryDays > 3650) {
      return apiError(
        c,
        400,
        'EXPIRY_DAYS_TOO_LARGE',
        'expiryDays must be 3650 or fewer',
      );
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

  if (!row)
    return apiError(c, 500, 'FAILED_TO_CREATE_LINK', 'Failed to create link');

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

  if (!row) return apiError(c, 404, 'LINK_NOT_FOUND', 'Link not found');
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

  if (!existing) return apiError(c, 404, 'LINK_NOT_FOUND', 'Link not found');

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
  if (!body) return apiError(c, 400, 'INVALID_JSON_BODY', 'Invalid JSON body');

  let newSlug = existing.slug;
  if (body.customSlug !== undefined && body.customSlug !== existing.slug) {
    const customSlug = body.customSlug.trim();
    if (!isValidSlug(customSlug)) {
      return apiError(c, 400, 'INVALID_SLUG', 'Invalid slug');
    }
    if (isReservedSlug(customSlug)) {
      return apiError(c, 400, 'SLUG_RESERVED', 'This slug is reserved');
    }
    const conflict = await c.env.DB.prepare(
      `SELECT 1 FROM ${L} WHERE slug = ?1 AND id != ?2`,
    )
      .bind(customSlug, id)
      .first();
    if (conflict) return apiError(c, 409, 'SLUG_TAKEN', 'Slug already taken');
    newSlug = customSlug;
  }

  if (body.destinationUrl) {
    if (body.destinationUrl.length > 2048) {
      return apiError(
        c,
        400,
        'DESTINATION_URL_TOO_LONG',
        'destinationUrl must be 2048 characters or fewer',
      );
    }
    try {
      const parsed = new URL(body.destinationUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return apiError(
          c,
          400,
          'ONLY_HTTP_HTTPS_ALLOWED',
          'Only http and https URLs are allowed',
        );
      }
    } catch {
      return apiError(c, 400, 'INVALID_URL', 'Invalid URL');
    }
  }

  if (body.title && body.title.length > 255) {
    return apiError(
      c,
      400,
      'TITLE_TOO_LONG',
      'title must be 255 characters or fewer',
    );
  }

  let expiresAt = existing.expires_at;
  const now = Math.floor(Date.now() / 1000);
  if (body.expiresAt !== undefined) {
    if (body.expiresAt !== null) {
      if (!Number.isSafeInteger(body.expiresAt)) {
        return apiError(
          c,
          400,
          'EXPIRES_AT_INVALID',
          'expiresAt must be an integer Unix timestamp',
        );
      }
      if (body.expiresAt <= now) {
        return apiError(
          c,
          400,
          'EXPIRES_AT_IN_PAST',
          'expiresAt must be in the future',
        );
      }
    }
    expiresAt = body.expiresAt;
  } else if (body.expiryDays !== undefined) {
    if (body.expiryDays && body.expiryDays > 3650) {
      return apiError(
        c,
        400,
        'EXPIRY_DAYS_TOO_LARGE',
        'expiryDays must be 3650 or fewer',
      );
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

  if (!existing) return apiError(c, 404, 'LINK_NOT_FOUND', 'Link not found');

  await c.env.DB.prepare(`DELETE FROM ${L} WHERE id = ?1`).bind(id).run();
  await deleteCachedLink(c.env.LINKS_KV, existing.slug);

  return c.json({ success: true });
});

export default links;
