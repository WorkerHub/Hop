// Silent-switch guard + three-state resolution for the shared migration runner
// (ONE-203 / ONE-205).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
  WRANGLER_MIGRATION_FILES,
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

// Wrangler's own migration ledger as it appears on the shared D1 database: a
// database-wide singleton table, left behind (with that app's file names) by
// any other app that ran `wrangler d1 migrations apply` there.
function wranglerHistory(db: D1Mock, names: string[]): void {
  db.exec(`CREATE TABLE d1_migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`);
  for (const name of names) {
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
  }
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

// ─── 回归：d1_migrations 内容判定（ONE-478）────────────────────────────────

// d1_migrations 是全库单例表，只含别家文件名时不算本应用的无前缀信号：
// 前缀表全删后的从零重装必须能过。
test('回归：仅外来 d1_migrations（别家文件名）+ prefix=SL → 不误判为静默切换', async () => {
  const db = new D1Mock(false);
  wranglerHistory(db, ['0001_other_app.sql', '0002_other_app.sql']);
  const result = await runMigrations({
    DB: db as unknown as never,
    TABLE_PREFIX: 'SL',
  });
  assert.equal(result.prefix, 'SL');
  assert.deepEqual(
    result.migrations.map((m) => [m.name, m.status]),
    [
      ['schema_v1', 'applied'],
      ['schema_v2', 'applied'],
    ],
  );
  assert.deepEqual(
    db
      .prepare('SELECT name FROM _SL_schema_migrations ORDER BY name')
      .all<{ name: string }>()
      .results.map((r) => r.name),
    ['schema_v1', 'schema_v2'],
  );
});

// 防修过头：本应用自己的迁移文件名命中时，真正的静默切换仍必须拒绝。
test('回归：d1_migrations 含本应用迁移文件名 + prefix=SL → 仍抛 TablePrefixConflict', async () => {
  const db = new D1Mock(false);
  wranglerHistory(db, ['0001_other_app.sql', '0001_init.sql']);
  await assert.rejects(
    runMigrations({ DB: db as unknown as never, TABLE_PREFIX: 'SL' }),
    (err: unknown) => {
      assert.ok(err instanceof TablePrefixConflictError);
      assert.match((err as Error).message, /unprefixed schema/);
      return true;
    },
  );
  // 被拒后不得写入任何 SL 表或账本。
  assert.deepEqual(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND (name GLOB 'SL_*' OR name GLOB '_SL_*')",
      )
      .all<{ name: string }>()
      .results.map((r) => r.name),
    [],
  );
});

// 部署脚本侧以 apps/worker/migrations/ 目录枚举为真源、运行时以常量为真源，
// 两者漂移即红（新增 Wrangler 迁移文件却漏同步常量时 CI 会挂）。
test('WRANGLER_MIGRATION_FILES 与 migrations/ 目录实际文件集合相等', () => {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'migrations',
  );
  const onDisk = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(onDisk.length > 0);
  assert.deepEqual([...WRANGLER_MIGRATION_FILES].sort(), onDisk);
});
