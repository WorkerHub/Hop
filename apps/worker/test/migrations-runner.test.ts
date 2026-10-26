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

test('runMigrations 返回实际生效前缀（未配置 → hop）', async () => {
  const db = new D1Mock(false);
  const result = await runMigrations({
    DB: db as unknown as never,
    TABLE_PREFIX: undefined,
  });
  assert.equal(result.prefix, 'hop');
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

// ─── 回归：共享库他表 + 三态边界（ONE-206 修复）─────────────────────────────

test('回归：共享库他表 bare users + Hop 已有前缀 → 增量放行不误杀', async () => {
  const db = initializedDb('SL');
  // 他应用留下的 bare users 表，不应触发防静默切换误判。
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY);');
  const result = await runMigrations({
    DB: db as unknown as never,
    TABLE_PREFIX: 'SL',
  });
  assert.equal(result.prefix, 'SL');
  assert.deepEqual(
    result.migrations.map((m) => m.status),
    ['skipped', 'skipped'],
  );
});

test('回归：共享库他表（ZETA_*/eNotify_*）+ 显式空前缀 → 不误判为前缀', async () => {
  const db = new D1Mock(false);
  // 仅他应用的前缀表，Hop 自身无任何 schema；显式空前缀应放行。
  db.exec(
    'CREATE TABLE ZETA_links (id TEXT, slug TEXT);' +
      'CREATE TABLE eNotify_settings (key TEXT, value TEXT);',
  );
  const result = await runMigrations({
    DB: db as unknown as never,
    TABLE_PREFIX: '',
  });
  assert.equal(result.prefix, '');
  assert.deepEqual(
    result.migrations.map((m) => [m.name, m.status]),
    [
      ['schema_v1', 'applied'],
      ['schema_v2', 'applied'],
    ],
  );
});
