import type { Env } from '../types.js';
import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
} from './migrations.js';
import { resolveTablePrefix } from './table-prefix.js';

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
  // The effective table prefix that was resolved for this run ('' when the
  // deployer explicitly configured no prefix).
  prefix: string;
  migrations: MigrationResult[];
}

// Thrown when the database already contains an initialised schema under a
// different prefix than the one resolved from the environment — migrating
// would silently switch the app to a different (usually empty) set of tables.
export class TablePrefixConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TablePrefixConflictError';
  }
}

// The tables this app owns (suffix after the prefix). Used to recognise an
// already-initialised schema without touching other apps' tables in the shared
// D1 database.
const OWN_TABLE_SUFFIXES = [
  'users',
  'passkeys',
  'links',
  'click_logs',
  'verifications',
  'settings',
  'audit_logs',
  'totp_used',
] as const;

// Returns a human-readable description of a conflicting already-initialised
// schema, or null when the database is safe to migrate under `prefix`.
// Read-only: never writes to the database.
async function detectTablePrefixConflict(
  db: Pick<Env, 'DB'>['DB'],
  prefix: string,
): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  const names = results.map((r) => r.name);
  const has = (t: string) =>
    names.some((n) => n.toLowerCase() === t.toLowerCase());

  if (prefix !== '') {
    // Resolving to a prefixed schema, but an unprefixed schema of this app is
    // already initialised (the setup route always records its history in
    // `_schema_migrations`, and `users` is the first business table).
    if (has('_schema_migrations') || has('users')) {
      return (
        `the database already contains an unprefixed schema (` +
        `users / _schema_migrations), but TABLE_PREFIX resolves to '${prefix}'. ` +
        `Refusing to initialise a new '${prefix}'-prefixed schema. ` +
        `To keep the existing unprefixed schema, explicitly configure ` +
        `TABLE_PREFIX='' (or TABLE_PREFIX=none in CI).`
      );
    }
    return null;
  }

  // Resolving to no prefix, but a prefixed schema of this app is already
  // initialised. Only this app's own table suffixes count, so other apps
  // sharing the D1 database are left alone.
  const prefixed = names.filter((n) => {
    const m = /^([A-Za-z0-9_]+)_([A-Za-z0-9_]+)$/.exec(n);
    return (
      m !== null &&
      (OWN_TABLE_SUFFIXES as readonly string[]).includes(m[2] ?? '')
    );
  });
  const historyPrefixes = names
    .map((n) => /^_([A-Za-z0-9_]+)_schema_migrations$/.exec(n))
    .filter((m) => m !== null)
    .map((m) => (m as RegExpExecArray)[1] ?? '');
  const detected = [
    ...new Set([
      ...historyPrefixes,
      ...prefixed.map((n) => /^([A-Za-z0-9_]+)_/.exec(n)?.[1] ?? ''),
    ]),
  ].filter((p) => p !== '');

  if (detected.length > 0) {
    return (
      `the database already contains a prefixed schema ` +
      `(${detected.map((p) => `${p}_*`).join(', ')}), but TABLE_PREFIX resolves ` +
      `to an empty string (no prefix). Refusing to initialise an unprefixed ` +
      `schema. To keep the existing prefixed schema, configure TABLE_PREFIX to ` +
      `its current value (e.g. TABLE_PREFIX=${detected[0]}).`
    );
  }
  return null;
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
  const prefix = resolveTablePrefix(env.TABLE_PREFIX);

  // Silent-switch guard (highest priority): never initialise a schema under a
  // different prefix than the one the database already holds.
  const conflict = await detectTablePrefixConflict(env.DB, prefix);
  if (conflict !== null) {
    throw new TablePrefixConflictError(conflict);
  }

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

  return { prefix, migrations };
}
