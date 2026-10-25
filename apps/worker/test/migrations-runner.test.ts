// Silent-switch guard + three-state resolution for the shared migration runner
// (ONE-203 / ONE-205).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
} from '../src/lib/migrations.ts';
import {
  runMigrations,
  TablePrefixConflictError,
} from '../src/lib/migrations-runner.ts';
import { D1Mock } from './helpers/env.ts';

// A database initialised under `prefix`: schema + migration history with every
// migration already recorded as applied.
function initializedDb(prefix: string): D1Mock {
  const db = new D1Mock(false);
  db.exec(createMigrationsTableSql(prefix));
  for (const migration of getMigrations(prefix)) {
    db.exec(migration.sql);
    db.prepare(`INSERT INTO ${migrationsTable(prefix)} (name) VALUES (?)`)
      .bind(migration.name)
      .run();
  }
  return db;
}

test('runMigrations 返回实际生效前缀（未配置 → sl）', async () => {
  const db = new D1Mock(false);
  const result = await runMigrations({
    DB: db as unknown as never,
    TABLE_PREFIX: undefined,
  });
  assert.equal(result.prefix, 'sl');
  assert.deepEqual(
    result.migrations.map((m) => [m.name, m.status]),
    [
      ['schema_v1', 'applied'],
      ['schema_v2', 'applied'],
    ],
  );
});

test('runMigrations 返回实际生效前缀（显式空 → 无前缀）', async () => {
  const db = new D1Mock(false);
  const result = await runMigrations({
    DB: db as unknown as never,
    TABLE_PREFIX: '',
  });
  assert.equal(result.prefix, '');
});

test('防静默切换：未配置（→ sl）但库中已有无前缀 schema → 中止报错', async () => {
  const db = initializedDb('');
  await assert.rejects(
    runMigrations({ DB: db as unknown as never, TABLE_PREFIX: undefined }),
    (err: unknown) => {
      assert.ok(err instanceof TablePrefixConflictError);
      assert.match((err as Error).message, /unprefixed schema/);
      assert.match((err as Error).message, /TABLE_PREFIX=''/);
      return true;
    },
  );
});

test('防静默切换：显式空前缀但库中已有 prefixed schema → 中止报错', async () => {
  const db = initializedDb('sl');
  await assert.rejects(
    runMigrations({ DB: db as unknown as never, TABLE_PREFIX: '' }),
    (err: unknown) => {
      assert.ok(err instanceof TablePrefixConflictError);
      assert.match((err as Error).message, /prefixed schema/);
      assert.match((err as Error).message, /sl_\*/);
      return true;
    },
  );
});

test('前缀一致时不误报：prefixed schema + 同名前缀正常迁移', async () => {
  const db = initializedDb('sl');
  const result = await runMigrations({
    DB: db as unknown as never,
    TABLE_PREFIX: 'sl',
  });
  assert.equal(result.prefix, 'sl');
  assert.deepEqual(
    result.migrations.map((m) => m.status),
    ['skipped', 'skipped'],
  );
});

test('前缀一致时不误报：unprefixed schema + 显式空前缀正常迁移', async () => {
  const db = initializedDb('');
  const result = await runMigrations({
    DB: db as unknown as never,
    TABLE_PREFIX: '',
  });
  assert.equal(result.prefix, '');
  assert.deepEqual(
    result.migrations.map((m) => m.status),
    ['skipped', 'skipped'],
  );
});

test('migrationsTable 与迁移 helper 共用前缀语义', () => {
  assert.equal(migrationsTable(''), '_schema_migrations');
  assert.equal(migrationsTable('sl'), '_sl_schema_migrations');
  assert.equal(migrationsTable('SL'), '_SL_schema_migrations');
});
