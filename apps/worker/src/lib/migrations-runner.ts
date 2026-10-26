import type { Env } from '../types.js';
import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
  WRANGLER_MIGRATION_FILES,
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

// Tables that are unique to this app across the shared D1 database. Other apps
// sharing the database (ZETA_*, eNotify_*, …) have none of these three, so their
// presence under one prefix marks a Hop schema. Never used for
// single-table matching.
const Hop_UNIQUE_SUFFIXES = ['passkeys', 'links', 'totp_used'] as const;

// Collects the prefixes under which a Hop schema appears to be
// initialised: either a prefixed migration-history table
// (`_<prefix>_schema_migrations`) or the intersection of the Hop-unique
// tables under the same prefix.
function detectPrefixedSchema(names: string[]): string[] {
  const prefixes = new Set<string>();

  for (const n of names) {
    const m = /^_([A-Za-z0-9_]+)_schema_migrations$/.exec(n);
    if (m !== null) prefixes.add(m[1] ?? '');
  }

  const byPrefix = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9_]+)_(passkeys|links|totp_used)$/.exec(n);
    if (m === null) continue;
    const prefix = m[1] ?? '';
    const suffix = m[2] ?? '';
    let suffixes = byPrefix.get(prefix);
    if (suffixes === undefined) {
      suffixes = new Set();
      byPrefix.set(prefix, suffixes);
    }
    suffixes.add(suffix);
  }
  for (const [prefix, suffixes] of byPrefix) {
    const unique = Hop_UNIQUE_SUFFIXES as readonly string[];
    if (unique.every((s) => suffixes.has(s))) {
      prefixes.add(prefix);
    }
  }

  return [...prefixes];
}

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

  // An unprefixed schema of this app: the legacy setup route records its
  // history in `_schema_migrations`, and wrangler's unprefixed path in
  // `d1_migrations`. A bare `users` table alone is NOT a signal — the shared
  // D1 database can carry other apps' tables. Neither is a bare `d1_migrations`
  // table: it is a database-wide singleton, left behind by any other app on the
  // shared database that ran `wrangler d1 migrations apply`, recording that
  // app's file names. Only rows naming this app's own migration files count.
  let hasUnprefixed = false;
  if (has('d1_migrations')) {
    const applied = await db
      .prepare('SELECT name FROM d1_migrations')
      .all<{ name: string }>();
    hasUnprefixed = applied.results.some((r) =>
      WRANGLER_MIGRATION_FILES.includes(r.name),
    );
  }
  if (has('_schema_migrations')) {
    const history = await db
      .prepare('SELECT name FROM _schema_migrations')
      .all<{ name: string }>();
    hasUnprefixed =
      hasUnprefixed || history.results.some((r) => r.name === 'schema_v1');
  }

  if (prefix !== '') {
    // Already initialised under this prefix → an incremental/idempotent
    // migration, not a silent switch. Allow it.
    if (has(migrationsTable(prefix))) {
      return null;
    }
    // Current prefix not initialised, but an unprefixed schema of this app
    // exists → switching would point at a new set of tables.
    if (hasUnprefixed) {
      return (
        `the database already contains an unprefixed schema (` +
        `_schema_migrations / d1_migrations), but TABLE_PREFIX resolves to '${prefix}'. ` +
        `Refusing to initialise a new '${prefix}'-prefixed schema. ` +
        `To keep the existing unprefixed schema, explicitly configure ` +
        `TABLE_PREFIX='' (or TABLE_PREFIX=none in CI).`
      );
    }
    return null;
  }

  // Resolving to no prefix: already-unprefixed is legal (incremental); a
  // prefixed schema of this app is a switch and must abort.
  if (hasUnprefixed) {
    return null;
  }
  const detected = detectPrefixedSchema(names);
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
