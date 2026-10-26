// Generates apps/worker/migrations/*.sql from src/lib/migrations.ts
// (getMigrations('')), so the wrangler migration files and the setup-route /
// prefixed migrations share a single source of truth.
//
// Run from apps/worker: `node --import tsx scripts/generate-migrations.ts`
// (or `pnpm generate:migrations`). The consistency test in
// test/migrations.test.ts fails if a checked-in .sql file drifts from the
// generated content.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getMigrations } from '../src/lib/migrations.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const HEADER =
  '-- DO NOT EDIT. Generated from src/lib/migrations.ts (getMigrations("")).\n' +
  '-- Regenerate with: pnpm --filter @Hop/worker generate:migrations\n';

// The setup route and the prefixed deploy path run getMigrations() directly,
// which uses idempotent forms (CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE) so
// they can re-run safely. The wrangler migration files, by contrast, must keep
// their original fail-if-exists semantics: wrangler tracks applied migrations,
// so a repeated CREATE TABLE should error rather than silently skip. Strip the
// idempotency markers when rendering the .sql files.
function toWranglerSql(sql: string): string {
  return sql
    .replace(/CREATE TABLE IF NOT EXISTS /gi, 'CREATE TABLE ')
    .replace(/CREATE INDEX IF NOT EXISTS /gi, 'CREATE INDEX ')
    .replace(/INSERT OR IGNORE INTO /gi, 'INSERT INTO ');
}

// Map of wrangler migration file name -> file content.
export function renderMigrationFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const migration of getMigrations('')) {
    files[migration.fileName] =
      `${HEADER}\n${toWranglerSql(migration.sql).trim()}\n`;
  }
  return files;
}

function isMain(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMain()) {
  mkdirSync(migrationsDir, { recursive: true });
  for (const [name, content] of Object.entries(renderMigrationFiles())) {
    writeFileSync(join(migrationsDir, name), content);
    console.log(`wrote migrations/${name}`);
  }
}
