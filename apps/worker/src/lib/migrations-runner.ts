import type { Env } from '../types.js';
import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
} from './migrations.js';

// Shared schema-migration execution, parameterised by TABLE_PREFIX. Both the
// secret-keyed HTTP endpoint (routes/setup.ts → POST /api/setup) and the
// admin-session endpoint (routes/admin.ts → POST /api/admin/setup) call this so
// the two stay byte-compatible.

export interface MigrationResult {
  name: string;
  status: 'applied' | 'skipped' | 'error';
  error?: string;
}

export interface RunMigrationsResult {
  migrations: MigrationResult[];
}

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

// Applies every migration in getMigrations(prefix) not yet recorded in
// `${prefix}schema_migrations`, stopping at the first error (which is reported
// inline rather than thrown, preserving the original setup-route semantics).
export async function runMigrations(
  env: Pick<Env, 'DB' | 'TABLE_PREFIX'>,
): Promise<RunMigrationsResult> {
  const prefix = env.TABLE_PREFIX ?? '';
  const historyTable = migrationsTable(prefix);

  // Use prepare().run() for single-statement DDL — avoids exec()'s newline limitation
  await env.DB.prepare(createMigrationsTableSql(prefix)).run();

  const { results } = await env.DB.prepare(
    `SELECT name FROM ${historyTable}`,
  ).all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));

  const migrations: MigrationResult[] = [];

  for (const migration of getMigrations(prefix)) {
    if (applied.has(migration.name)) {
      migrations.push({ name: migration.name, status: 'skipped' });
      continue;
    }
    try {
      await env.DB.exec(toSingleLine(migration.sql));
      await env.DB.prepare(`INSERT INTO ${historyTable} (name) VALUES (?)`)
        .bind(migration.name)
        .run();
      migrations.push({ name: migration.name, status: 'applied' });
    } catch (err) {
      migrations.push({
        name: migration.name,
        status: 'error',
        error: String(err),
      });
      break;
    }
  }

  return { migrations };
}
