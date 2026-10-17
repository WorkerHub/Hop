// 本地 D1 回归测试，不需要 Cloudflare 凭据，也不接触 apps/worker/.wrangler。
// 在仓库根目录运行：node --test .github/scripts/test-d1-migrations.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMigrationsTableSql,
  getMigrations,
  migrationsTable,
} from '../../apps/worker/src/lib/migrations.ts';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const worker = fileURLToPath(new URL('../../apps/worker/', import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'shortlink-d1-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'package.json'), '{"private":true}');
  writeFileSync(
    join(cwd, 'wrangler.toml'),
    `name = "shortlink-migration-test"
compatibility_date = "2025-04-01"
[[d1_databases]]
binding = "DB"
database_name = "shortlink-test"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"
`,
  );
  symlinkSync(join(worker, 'node_modules'), join(cwd, 'node_modules'));
  symlinkSync(join(worker, 'migrations'), join(cwd, 'migrations'));
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
    D1_LOCATION: 'local',
    GITHUB_OUTPUT: join(cwd, 'outputs'),
    // pnpm 11's default `verify-deps-before-run=install` makes `pnpm exec
    // wrangler` re-check deps and, in this fixture (a bare package.json with a
    // symlinked node_modules and no lockfile), run an install that writes
    // "Already up to date" / "Done in … using pnpm" to stdout — polluting
    // `wrangler d1 execute --json`. Disable the check so stdout stays clean.
    pnpm_config_verify_deps_before_run: 'false',
  };
  const run = (command, args, extraEnv = {}) =>
    execFileSync(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const query = (sql) =>
    JSON.parse(
      run('pnpm', [
        'exec',
        'wrangler',
        'd1',
        'execute',
        'DB',
        '--local',
        '--json',
        '--command',
        sql,
      ]),
    ).map((r) => r.results);
  const script = (name, prefix) =>
    run('bash', [join(scripts, name)], { TABLE_PREFIX: prefix });
  const setup = (prefix, names) => {
    query(
      `${createMigrationsTableSql(prefix)};${getMigrations(prefix)
        .filter((m) => names.includes(m.name))
        .map(
          (m) =>
            `${m.sql}\nINSERT INTO ${migrationsTable(prefix)} (name) VALUES ('${m.name}');`,
        )
        .join('\n')}`,
    );
  };
  const foreignSnapshot = () =>
    query(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE tbl_name IN ('users','ZETA_users','ZETA_links') ORDER BY name;
      SELECT * FROM users ORDER BY id;
      SELECT * FROM ZETA_users ORDER BY id;
      SELECT * FROM ZETA_links ORDER BY id;`);
  const shared = () => {
    query(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
      INSERT INTO users VALUES ('other-user', 'keep@example.com');
      CREATE TABLE ZETA_users (id TEXT PRIMARY KEY);
      INSERT INTO ZETA_users VALUES ('zeta-user');
      CREATE TABLE ZETA_links (id TEXT, slug TEXT);
      INSERT INTO ZETA_links VALUES ('zeta-link', 'keep');
      CREATE INDEX idx_ZETA_links_slug ON ZETA_links(slug);`);
    return foreignSnapshot();
  };
  // SQLite 索引名全库唯一：若别的应用已占用同名索引，CREATE INDEX IF NOT EXISTS
  // 会静默跳过。逐个核对迁移声明的索引确实建在本应用的表上。
  const assertOwnIndexes = (prefix) => {
    const expected = getMigrations(prefix)
      .flatMap((m) =>
        Array.from(
          m.sql.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON (\w+)/g),
          ([, name, tbl_name]) => ({ name, tbl_name }),
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.ok(expected.length > 0);
    assert.deepEqual(
      query(`SELECT name, tbl_name FROM sqlite_master
        WHERE type = 'index' AND name IN (${expected.map((i) => `'${i.name}'`).join(',')})
        ORDER BY name`)[0],
      expected,
    );
  };
  return {
    run,
    query,
    script,
    setup,
    shared,
    foreignSnapshot,
    assertOwnIndexes,
    env,
    cwd,
  };
}

test('无前缀：保留 Wrangler 迁移路径及重复执行行为', (t) => {
  const f = fixture(t);
  assert.match(f.script('d1-prepare-migrations.sh', ''), /Empty database/);
  f.run('pnpm', [
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
  ]);
  assert.deepEqual(f.query('SELECT name FROM d1_migrations ORDER BY name')[0], [
    { name: '0001_init.sql' },
    { name: '0002_token_version.sql' },
  ]);
  assert.match(f.script('d1-prepare-migrations.sh', ''), /already tracked/);
  assert.match(
    f.run('pnpm', [
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
    ]),
    /No migrations to apply/,
  );
});

test('无前缀：setup 历史可 baseline 为 Wrangler 历史', (t) => {
  const f = fixture(t);
  f.setup('', ['schema_v1', 'schema_v2']);
  assert.match(f.script('d1-prepare-migrations.sh', ''), /Baselining/);
  assert.deepEqual(f.query('SELECT name FROM d1_migrations ORDER BY name')[0], [
    { name: '0001_init.sql' },
    { name: '0002_token_version.sql' },
  ]);
});

test('有前缀且已全部执行：只打印空计划，仅执行 SELECT，共享库不变', (t) => {
  const f = fixture(t);
  const before = f.shared();
  f.setup('SL', ['schema_v1', 'schema_v2']);
  assert.match(f.script('d1-prepare-migrations.sh', 'SL'), /prefixed/);
  // Bash trace 核对脚本实际调用的每条 D1 SQL，不能只比较最终数据。
  const trace = f.run(
    'bash',
    [
      '-c',
      'bash -x "$1" 2>&1',
      'test',
      join(scripts, 'd1-prefixed-migrations.sh'),
    ],
    { TABLE_PREFIX: 'SL' },
  );
  assert.match(trace, /Planned migrations: none/);
  const calls = trace
    .split('\n')
    .filter((line) => /^\++ pnpm exec wrangler d1 execute /.test(line));
  assert.equal(calls.length, 2, trace);
  for (const call of calls) {
    assert.match(call, /--local --json --command 'SELECT /);
  }
  assert.deepEqual(f.foreignSnapshot(), before);
});

test('有前缀且有待执行迁移：仅应用 v2，保留其他应用的表、索引和数据', (t) => {
  const f = fixture(t);
  const before = f.shared();
  f.setup('SL', ['schema_v1']);
  f.query(`INSERT INTO SL_users (email,username,password_hash)
    VALUES ('sl@example.com','sl-user','hash')`);
  assert.match(
    f.script('d1-prefixed-migrations.sh', 'SL'),
    /Planned migrations: schema_v2\n/,
  );
  assert.deepEqual(
    f.query('SELECT name FROM _SL_schema_migrations ORDER BY name')[0],
    [{ name: 'schema_v1' }, { name: 'schema_v2' }],
  );
  f.assertOwnIndexes('SL');
  assert.deepEqual(f.query('SELECT email,token_version FROM SL_users')[0], [
    { email: 'sl@example.com', token_version: 0 },
  ]);
  assert.deepEqual(f.foreignSnapshot(), before);
  assert.match(
    f.script('d1-prefixed-migrations.sh', 'SL'),
    /Planned migrations: none/,
  );
});

test('有前缀的新安装：只创建本应用的表，共享库保持不变', (t) => {
  const f = fixture(t);
  const before = f.shared();
  assert.match(
    f.script('d1-prefixed-migrations.sh', 'SL'),
    /Planned migrations: schema_v1 schema_v2/,
  );
  assert.deepEqual(f.foreignSnapshot(), before);
  assert.deepEqual(
    f.query('SELECT name FROM _SL_schema_migrations ORDER BY name')[0],
    [{ name: 'schema_v1' }, { name: 'schema_v2' }],
  );
  f.assertOwnIndexes('SL');
});

test('已有业务表但无历史或历史为空：拒绝猜测 baseline，不写入其他应用', (t) => {
  const f = fixture(t);
  const before = f.shared();
  f.query('CREATE TABLE SL_users (id TEXT)');
  assert.throws(
    () => f.script('d1-prefixed-migrations.sh', 'SL'),
    /Command failed/,
  );
  f.query(createMigrationsTableSql('SL'));
  assert.throws(
    () => f.script('d1-prefixed-migrations.sh', 'SL'),
    /Command failed/,
  );
  assert.deepEqual(f.query('SELECT name FROM _SL_schema_migrations')[0], []);
  assert.deepEqual(f.foreignSnapshot(), before);
});

test('已知限制：别的应用占用同名索引时，本应用索引会被静默跳过（检查可发现）', (t) => {
  const f = fixture(t);
  f.shared();
  f.query('CREATE INDEX idx_links_slug ON ZETA_links(slug)');
  assert.match(
    f.script('d1-prefixed-migrations.sh', 'SL'),
    /Planned migrations: schema_v1 schema_v2/,
  );
  assert.throws(() => f.assertOwnIndexes('SL'), /Expected values/);
});
