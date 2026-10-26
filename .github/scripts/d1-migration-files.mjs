// Prints this app's Wrangler migration file names (apps/worker/migrations/*.sql),
// one per line, for the deploy scripts' anti-silent-switch guards.
//
// Wrangler's `d1_migrations` ledger is a database-wide singleton table: any
// other application on the shared D1 database that ever ran
// `wrangler d1 migrations apply` leaves it behind, recording *that* app's file
// names. Its mere existence therefore says nothing about an unprefixed schema
// of this app — only an intersection with this list does.
//
// The migrations directory is the single source of truth on the deploy side
// (enumerated here so no script carries a hardcoded list); the runtime
// equivalent is WRANGLER_MIGRATION_FILES in apps/worker/src/lib/migrations.ts,
// and apps/worker/test/migrations-runner.test.ts asserts the two are equal, so
// a drift between them fails CI.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(
  new URL('../../apps/worker/migrations/', import.meta.url),
);

const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`No migration files found in ${dir}`);
  process.exit(1);
}

process.stdout.write(`${files.join('\n')}\n`);
