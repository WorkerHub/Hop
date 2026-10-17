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
  '-- Regenerate with: pnpm --filter @shortlink/worker generate:migrations\n';

// Map of wrangler migration file name -> file content.
export function renderMigrationFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const migration of getMigrations('')) {
    files[migration.fileName] = `${HEADER}\n${migration.sql.trim()}\n`;
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
