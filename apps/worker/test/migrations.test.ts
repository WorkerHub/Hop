// BE-Q1: schema single source of truth. The wrangler migration files
// (migrations/*.sql) must be generated from src/lib/migrations.ts — this test
// fails if they drift apart, so CI catches a schema edit that only touches one
// of the two copies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderMigrationFiles } from '../scripts/generate-migrations.ts';
import { getMigrations } from '../src/lib/migrations.ts';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

test('每个 wrangler 迁移文件都来自 getMigrations("")，内容一致 (BE-Q1)', () => {
  const expected = renderMigrationFiles();
  const names = Object.keys(expected);
  assert.ok(names.length > 0, 'expected at least one migration file');

  for (const name of names) {
    const onDisk = readFileSync(join(migrationsDir, name), 'utf8');
    assert.equal(
      onDisk,
      expected[name],
      `${name} 与生成内容不一致，请运行 generate:migrations`,
    );
  }
});

test('迁移名与文件名遵循 schema_vN <-> NNNN_*.sql 约定 (BE-Q1)', () => {
  for (const migration of getMigrations('')) {
    const match = /^schema_v(\d+)$/.exec(migration.name);
    assert.ok(match, `migration name ${migration.name} must be schema_vN`);
    const num = match?.[1] ?? '';
    assert.equal(
      migration.fileName,
      `${num.padStart(4, '0')}_${migration.fileName.split('_').slice(1).join('_')}`,
      `${migration.name} 的 fileName 数字前缀必须与版本号一致`,
    );
    assert.match(migration.fileName, /^\d{4}_.+\.sql$/);
  }
});
