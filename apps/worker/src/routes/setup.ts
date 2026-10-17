import { Hono } from 'hono';
import { constantTimeEqual } from '../lib/crypto.js';
import { checkSetupRateLimit } from '../lib/kv.js';
import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
} from '../lib/migrations.js';
import type { Env, Variables } from '../types.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// D1's exec() only processes the first line of a multi-line string.
// Strip SQL line comments and collapse all whitespace to a single line.
function toSingleLine(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// BE-S5: POST + header secret (kept out of URL/logs), constant-time comparison,
// and per-IP rate limiting. When SETUP_SECRET is not set the endpoint 404s.
app.post('/', async (c) => {
  if (!c.env.SETUP_SECRET) {
    return c.notFound();
  }

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const allowed = await checkSetupRateLimit(c.env.LINKS_KV, ip);
  if (!allowed) {
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  }

  const provided = c.req.header('X-Setup-Secret') ?? '';
  if (!constantTimeEqual(provided, c.env.SETUP_SECRET)) {
    return c.notFound();
  }

  const prefix = c.env.TABLE_PREFIX ?? '';
  const historyTable = migrationsTable(prefix);

  // Use prepare().run() for single-statement DDL — avoids exec()'s newline limitation
  await c.env.DB.prepare(createMigrationsTableSql(prefix)).run();

  const { results } = await c.env.DB.prepare(
    `SELECT name FROM ${historyTable}`,
  ).all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));

  const log: {
    name: string;
    status: 'applied' | 'skipped' | 'error';
    error?: string;
  }[] = [];

  for (const migration of getMigrations(prefix)) {
    if (applied.has(migration.name)) {
      log.push({ name: migration.name, status: 'skipped' });
      continue;
    }
    try {
      await c.env.DB.exec(toSingleLine(migration.sql));
      await c.env.DB.prepare(`INSERT INTO ${historyTable} (name) VALUES (?)`)
        .bind(migration.name)
        .run();
      log.push({ name: migration.name, status: 'applied' });
    } catch (err) {
      log.push({ name: migration.name, status: 'error', error: String(err) });
      break;
    }
  }

  return c.json({ migrations: log });
});

export default app;
