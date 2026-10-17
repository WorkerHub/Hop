// Emits the setup-route migrations for a TABLE_PREFIX as JSON, for
// d1-prefixed-migrations.sh. The migrations come straight from
// apps/worker/src/lib/migrations.ts (loaded via Node's TypeScript type
// stripping), so the deploy workflow and POST /setup can never drift apart.
//
//   node d1-migrations.mjs <prefix>
//   -> { "historyTable": "_SL_schema_migrations",
//        "migrations": [{ "name": "schema_v1", "sql": "<migration + history row>" }, ...] }
//
// The production D1 database is shared with other applications, so every
// statement is checked before anything is emitted: only additive statements
// (CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE ... ADD, INSERT INTO) are
// allowed, and each must target a table carrying this app's prefix. Anything
// else aborts the deploy.

import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
} from '../../apps/worker/src/lib/migrations.ts';

const prefix = process.argv[2] ?? '';
if (!/^[A-Za-z0-9_]+$/.test(prefix)) {
  console.error(
    `Invalid table prefix ${JSON.stringify(prefix)}: expected [A-Za-z0-9_]+`,
  );
  process.exit(1);
}

const ownTable = (name) => name.startsWith(`${prefix}_`);

// Statement shapes allowed in a migration; the capture group is the table
// written to. Quoted identifiers deliberately do not match.
const ALLOWED = [
  /^CREATE TABLE IF NOT EXISTS (\w+) ?\(/i,
  /^CREATE INDEX IF NOT EXISTS \w+ ON (\w+) ?\(/i,
  /^ALTER TABLE (\w+) ADD (?:COLUMN )?\w+ /i,
  /^INSERT OR IGNORE INTO (\w+) ?\(/i,
];

function statements(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''") // string literals can't hide SQL
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function check(migration) {
  if (!/^schema_v\d+$/.test(migration.name)) {
    throw new Error(`unexpected migration name ${migration.name}`);
  }
  for (const stmt of statements(migration.sql)) {
    const match = ALLOWED.map((re) => stmt.match(re)).find(Boolean);
    if (!match) {
      throw new Error(
        `${migration.name}: statement is not additive: ${stmt.slice(0, 120)}`,
      );
    }
    const touched = [
      match[1],
      ...Array.from(stmt.matchAll(/REFERENCES (\w+)/gi), (m) => m[1]),
    ];
    const foreign = touched.filter((t) => !ownTable(t));
    if (foreign.length > 0) {
      throw new Error(
        `${migration.name}: references table(s) without prefix "${prefix}_": ${foreign.join(', ')}`,
      );
    }
  }
}

try {
  const historyTable = migrationsTable(prefix);
  const migrations = getMigrations(prefix);
  const names = migrations.map((m) => m.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`duplicate migration names: ${names.join(', ')}`);
  }
  for (const m of migrations) check(m);

  // Same history table and row format as POST /setup. The history row goes in
  // the same request, after the DDL: D1 stops at the first failing statement,
  // so a migration is never recorded without having run.
  const out = migrations.map((m) => ({
    name: m.name,
    sql: [
      `${createMigrationsTableSql(prefix)};`,
      m.sql.trim(),
      `INSERT INTO ${historyTable} (name) VALUES ('${m.name}');`,
    ].join('\n'),
  }));
  process.stdout.write(
    `${JSON.stringify({ historyTable, migrations: out }, null, 2)}\n`,
  );
} catch (err) {
  console.error(`Refusing to emit migrations: ${err.message}`);
  process.exit(1);
}
