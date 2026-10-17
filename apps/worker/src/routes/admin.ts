import { Hono } from 'hono';
import { hashPassword } from '../lib/crypto.js';
import { tbl } from '../lib/db.js';
import { deleteCachedLink, deleteCachedSetting } from '../lib/kv.js';
import { requireAdmin } from '../middleware/auth.js';
import type { Env, LinkRow, UserRow, Variables } from '../types.js';

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

admin.use('*', requireAdmin);

// BE-S1: Setting keys that hold secrets. They must never be written in plaintext
// to the audit log, nor returned in plaintext by GET /settings.
const SECRET_SETTING_KEYS = new Set(['smtp_pass', 'resend_api_key']);
const SECRET_MASK = '***';

function maskSecrets(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    // Only mask configured (non-empty) secrets — an empty value means "not set",
    // so it must stay empty rather than read as "***" (= already set) by the UI.
    out[k] = SECRET_SETTING_KEYS.has(k) && v !== '' ? SECRET_MASK : v;
  }
  return out;
}

// ─── Audit log helper (L7) ────────────────────────────────────────────────────

async function auditLog(
  env: Pick<Env, 'DB' | 'TABLE_PREFIX'>,
  adminId: string,
  action: string,
  targetId: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ${tbl(env, 'audit_logs')} (admin_id, action, target_id, details) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(adminId, action, targetId, details ? JSON.stringify(details) : null)
    .run();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/stats
// ─────────────────────────────────────────────────────────────────────────────
admin.get('/stats', async (c) => {
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;

  const [users, links, clicksToday, clicksTotal] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${tbl(c.env, 'users')}`),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${tbl(c.env, 'links')}`),
    c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM ${tbl(c.env, 'click_logs')} WHERE created_at >= ?1`,
    ).bind(dayAgo),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${tbl(c.env, 'click_logs')}`),
  ]);

  return c.json({
    users: (users?.results[0] as { n: number }).n,
    links: (links?.results[0] as { n: number }).n,
    clicksToday: (clicksToday?.results[0] as { n: number }).n,
    clicksTotal: (clicksTotal?.results[0] as { n: number }).n,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users
// ─────────────────────────────────────────────────────────────────────────────
admin.get('/users', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(
    50,
    Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)),
  );
  const search = c.req.query('search')?.trim() ?? '';
  const offset = (page - 1) * limit;
  const U = tbl(c.env, 'users');

  let query: string;
  let countQuery: string;
  const baseBinds: (string | number)[] = [];
  const safe = search.replace(/[%_\\]/g, '\\$&');

  if (search) {
    query = `SELECT id, email, username, role, is_active, totp_enabled, passkey_enabled, email_2fa_enabled, created_at
             FROM ${U} WHERE email LIKE ?1 ESCAPE '\\' OR username LIKE ?1 ESCAPE '\\'
             ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`;
    countQuery = `SELECT COUNT(*) as n FROM ${U} WHERE email LIKE ?1 ESCAPE '\\' OR username LIKE ?1 ESCAPE '\\'`;
    baseBinds.push(`%${safe}%`, limit, offset);
  } else {
    query = `SELECT id, email, username, role, is_active, totp_enabled, passkey_enabled, email_2fa_enabled, created_at
             FROM ${U} ORDER BY created_at DESC LIMIT ?1 OFFSET ?2`;
    countQuery = `SELECT COUNT(*) as n FROM ${U}`;
    baseBinds.push(limit, offset);
  }

  const [rows, countRow] = await c.env.DB.batch([
    c.env.DB.prepare(query).bind(...baseBinds),
    c.env.DB.prepare(countQuery).bind(...(search ? [`%${safe}%`] : [])),
  ]);

  const total = (countRow?.results[0] as { n: number } | undefined)?.n ?? 0;

  return c.json({
    users: rows?.results,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users  — admin creates a new user
// ─────────────────────────────────────────────────────────────────────────────
admin.post('/users', async (c) => {
  const adminId = c.get('userId');
  const body = await c.req
    .json<{
      email: string;
      username: string;
      password: string;
      role?: 'admin' | 'user';
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  if (!body.email || !body.username || !body.password) {
    return c.json({ error: 'email, username, and password are required' }, 400);
  }

  const email = body.email.trim().toLowerCase();
  const username = body.username.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Invalid email address' }, 400);
  }
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return c.json(
      {
        error:
          'Username must be 3–32 characters: letters, numbers, dashes, or underscores',
      },
      400,
    );
  }
  if (body.password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }
  if (body.password.length > 256) {
    return c.json({ error: 'Password too long' }, 400);
  }
  if (body.role !== undefined && !['admin', 'user'].includes(body.role)) {
    return c.json({ error: 'role must be "admin" or "user"' }, 400);
  }

  const U = tbl(c.env, 'users');
  const existing = await c.env.DB.prepare(
    `SELECT id FROM ${U} WHERE email = ?1 OR username = ?2`,
  )
    .bind(email, username)
    .first();
  if (existing) {
    return c.json({ error: 'Email or username already taken' }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  const role = body.role ?? 'user';

  const result = await c.env.DB.prepare(
    `INSERT INTO ${U} (email, username, password_hash, role) VALUES (?1, ?2, ?3, ?4) RETURNING id, email, username, role`,
  )
    .bind(email, username, passwordHash, role)
    .first<{ id: string; email: string; username: string; role: string }>();

  if (!result) return c.json({ error: 'Failed to create user' }, 500);

  await auditLog(c.env, adminId, 'create_user', result.id, {
    email,
    username,
    role,
  });

  return c.json(
    {
      user: {
        id: result.id,
        email: result.email,
        username: result.username,
        role: result.role,
      },
    },
    201,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id
// ─────────────────────────────────────────────────────────────────────────────
admin.patch('/users/:id', async (c) => {
  const adminId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req
    .json<{ isActive?: boolean; role?: 'admin' | 'user' }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  if (body.role !== undefined && !['admin', 'user'].includes(body.role)) {
    return c.json({ error: 'role must be "admin" or "user"' }, 400);
  }

  if (id === adminId && body.role === 'user') {
    return c.json({ error: 'Cannot demote yourself' }, 400);
  }
  if (id === adminId && body.isActive === false) {
    return c.json({ error: 'Cannot deactivate yourself' }, 400);
  }

  const U = tbl(c.env, 'users');
  const user = await c.env.DB.prepare(`SELECT id FROM ${U} WHERE id = ?1`)
    .bind(id)
    .first<Pick<UserRow, 'id'>>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const sets: string[] = ['updated_at = unixepoch()'];
  const vals: (string | number)[] = [];

  if (body.isActive !== undefined) {
    sets.push(`is_active = ?${vals.push(body.isActive ? 1 : 0)}`);
  }
  if (body.role !== undefined) {
    sets.push(`role = ?${vals.push(body.role)}`);
  }

  // BE-S4: Deactivating or changing a user's role revokes all of their sessions
  // immediately by bumping token_version (checked on every request + refresh).
  if (body.isActive === false || body.role !== undefined) {
    sets.push('token_version = token_version + 1');
  }

  if (sets.length === 1) return c.json({ error: 'Nothing to update' }, 400);

  vals.push(id);
  await c.env.DB.prepare(
    `UPDATE ${U} SET ${sets.join(', ')} WHERE id = ?${vals.length}`,
  )
    .bind(...vals)
    .run();

  await auditLog(c.env, adminId, 'update_user', id, {
    isActive: body.isActive,
    role: body.role,
  });

  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:id
// ─────────────────────────────────────────────────────────────────────────────
admin.delete('/users/:id', async (c) => {
  const adminId = c.get('userId');
  const id = c.req.param('id');

  if (id === adminId) return c.json({ error: 'Cannot delete yourself' }, 400);

  const L = tbl(c.env, 'links');
  const slugRows = await c.env.DB.prepare(
    `SELECT slug FROM ${L} WHERE user_id = ?1`,
  )
    .bind(id)
    .all<Pick<LinkRow, 'slug'>>();

  const result = await c.env.DB.prepare(
    `DELETE FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
  )
    .bind(id)
    .run();
  if (result.meta.changes === 0)
    return c.json({ error: 'User not found' }, 404);

  await Promise.all(
    slugRows.results.map((r) => deleteCachedLink(c.env.LINKS_KV, r.slug)),
  );

  await auditLog(c.env, adminId, 'delete_user', id);

  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/links
// ─────────────────────────────────────────────────────────────────────────────
admin.get('/links', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)),
  );
  const search = c.req.query('search')?.trim() ?? '';
  const userId = c.req.query('userId');
  const offset = (page - 1) * limit;

  const L = tbl(c.env, 'links');
  const U = tbl(c.env, 'users');
  const CL = tbl(c.env, 'click_logs');
  const conditions: string[] = [];
  const binds: (string | number)[] = [];

  if (userId) {
    binds.push(userId);
    conditions.push(`l.user_id = ?${binds.length}`);
  }
  if (search) {
    const safe = search.replace(/[%_\\]/g, '\\$&');
    binds.push(`%${safe}%`);
    conditions.push(
      `(l.slug LIKE ?${binds.length} ESCAPE '\\' OR l.destination_url LIKE ?${binds.length} ESCAPE '\\')`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRow] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT l.rowid as seq, l.id, l.slug, l.destination_url, l.title, l.expires_at, l.is_active, l.created_at,
              u.email as user_email, u.username as user_username,
              (SELECT COUNT(*) FROM ${CL} WHERE link_id = l.id) as click_count
       FROM ${L} l JOIN ${U} u ON l.user_id = u.id
       ${where} ORDER BY l.created_at DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
    ).bind(...binds, limit, offset),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${L} l ${where}`).bind(
      ...binds,
    ),
  ]);

  const total = (countRow?.results[0] as { n: number } | undefined)?.n ?? 0;

  return c.json({
    links: rows?.results,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/settings
// ─────────────────────────────────────────────────────────────────────────────
admin.get('/settings', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT key, value FROM ${tbl(c.env, 'settings')}`,
  ).all<{
    key: string;
    value: string;
  }>();
  const settings = Object.fromEntries(
    rows.results.map((r) => [r.key, r.value]),
  );
  // BE-S1: Never return secret values in plaintext — replace with a mask so the
  // admin UI can show "already set" without exposing the credential.
  return c.json({ settings: maskSecrets(settings) });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/settings
// ─────────────────────────────────────────────────────────────────────────────
admin.put('/settings', async (c) => {
  const adminId = c.get('userId');
  const body = await c.req.json<Record<string, string>>().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  const allowedKeys = new Set([
    'registration_enabled',
    'require_email_verification',
    'app_name',
    'email_provider',
    'resend_api_key',
    'email_from_domain',
    'email_from_name',
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_pass',
    'smtp_from',
  ]);

  // FE-S3/BE-S1: An empty or masked ("***") secret means "leave unchanged".
  // Never write those back — an empty string would wipe the credential, and a
  // "***" literal would be stored as the real password.
  const updates = Object.entries(body)
    .filter(([k]) => allowedKeys.has(k))
    .filter(
      ([k, v]) =>
        !SECRET_SETTING_KEYS.has(k) || (v !== '' && v !== SECRET_MASK),
    );
  if (updates.length === 0)
    return c.json({ error: 'No valid settings keys provided' }, 400);

  const appNameEntry = updates.find(([k]) => k === 'app_name');
  if (appNameEntry) {
    const v = appNameEntry[1];
    if (
      typeof v !== 'string' ||
      v.length === 0 ||
      v.length > 64 ||
      /[<>"'&\r\n]/.test(v)
    ) {
      return c.json(
        {
          error:
            'app_name must be 1\u201364 printable characters with no HTML or newline characters',
        },
        400,
      );
    }
  }

  const providerEntry = updates.find(([k]) => k === 'email_provider');
  if (providerEntry && !['resend', 'smtp'].includes(providerEntry[1])) {
    return c.json({ error: 'email_provider must be "resend" or "smtp"' }, 400);
  }

  const portEntry = updates.find(([k]) => k === 'smtp_port');
  if (portEntry) {
    const p = parseInt(portEntry[1], 10);
    if (Number.isNaN(p) || p < 1 || p > 65535) {
      return c.json(
        { error: 'smtp_port must be a number between 1 and 65535' },
        400,
      );
    }
  }

  const fromEntry = updates.find(([k]) => k === 'smtp_from');
  if (fromEntry && fromEntry[1] !== '') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEntry[1])) {
      return c.json({ error: 'smtp_from must be a valid email address' }, 400);
    }
  }

  const fromDomainEntry = updates.find(([k]) => k === 'email_from_domain');
  if (fromDomainEntry && fromDomainEntry[1] !== '') {
    if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(fromDomainEntry[1])) {
      return c.json(
        { error: 'email_from_domain must be a bare domain (e.g. example.com)' },
        400,
      );
    }
  }

  const smtpTextKeys = new Set([
    'smtp_host',
    'smtp_user',
    'smtp_pass',
    'smtp_from',
    'resend_api_key',
    'email_from_domain',
    'email_from_name',
  ]);
  for (const [key, value] of updates) {
    if (smtpTextKeys.has(key) && /[\r\n]/.test(value)) {
      return c.json(
        { error: `${key} must not contain newline characters` },
        400,
      );
    }
  }

  const S = tbl(c.env, 'settings');
  await Promise.all(
    updates.map(async ([key, value]) => {
      await c.env.DB.prepare(
        `INSERT INTO ${S} (key, value, updated_at) VALUES (?1, ?2, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = unixepoch()`,
      )
        .bind(key, value)
        .run();
      await deleteCachedSetting(c.env.LINKS_KV, key);
    }),
  );

  await auditLog(c.env, adminId, 'update_settings', 'settings', {
    // BE-S1: Mask secrets so they never land in the audit log in plaintext.
    updates: maskSecrets(Object.fromEntries(updates)),
  });

  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/links/:id
// ─────────────────────────────────────────────────────────────────────────────
admin.delete('/links/:id', async (c) => {
  const adminId = c.get('userId');
  const id = c.req.param('id');
  const L = tbl(c.env, 'links');

  const existing = await c.env.DB.prepare(`SELECT slug FROM ${L} WHERE id = ?1`)
    .bind(id)
    .first<Pick<LinkRow, 'slug'>>();

  if (!existing) return c.json({ error: 'Link not found' }, 404);

  await c.env.DB.prepare(`DELETE FROM ${L} WHERE id = ?1`).bind(id).run();
  await deleteCachedLink(c.env.LINKS_KV, existing.slug);

  await auditLog(c.env, adminId, 'delete_link', id, { slug: existing.slug });

  return c.json({ success: true });
});

export default admin;
