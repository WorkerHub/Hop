// schema_v3 — the executionId ledger the waker callback writes through.
//
// Two guarantees the waker migration contract asks for:
//   1. the columns match the waker client SDK's executionLedgerDdl() one for
//      one (so SDK upgrades that need a column change fail here, loudly);
//   2. the table name goes through TABLE_PREFIX (hop_waker_executions by
//      default) and no other project's table is touched.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { getMigrations } from '../src/lib/migrations.ts';
import { executionLedgerDdl } from '../src/waker/ledger.ts';

/** Column definitions of a `CREATE TABLE name ( … );` statement, normalised. */
function columnDefinitions(ddl: string): string[] {
  const open = ddl.indexOf('(');
  const close = ddl.lastIndexOf(')');
  assert.ok(open > 0 && close > open, `not a CREATE TABLE statement: ${ddl}`);
  return ddl
    .slice(open + 1, close)
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\s+/g, ' '));
}

function schemaV3(prefix: string): string {
  const migration = getMigrations(prefix).find((m) => m.name === 'schema_v3');
  assert.ok(migration, 'schema_v3 迁移缺失');
  return migration.sql;
}

test('schema_v3 的列与 SDK executionLedgerDdl() 逐列一致', () => {
  const sdk = columnDefinitions(executionLedgerDdl('hop_waker_executions'));
  const migration = columnDefinitions(schemaV3('hop'));
  assert.deepEqual(migration, sdk);
});

test('schema_v3 只建 {prefix}waker_executions 一张表，不碰共享库里其他表', () => {
  const sql = schemaV3('hop');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  assert.equal(statements.length, 1);
  assert.match(
    statements[0] ?? '',
    /^CREATE TABLE IF NOT EXISTS hop_waker_executions \(/,
  );
  assert.doesNotMatch(sql, /DROP |ALTER TABLE (?!hop_waker_executions)/i);
});

test('默认前缀下建出 hop_waker_executions，列名与主键符合 SDK 契约', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(getMigrations('hop').find((m) => m.name === 'schema_v3')?.sql ?? '');
  const columns = db
    .prepare('PRAGMA table_info(hop_waker_executions)')
    .all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
  assert.deepEqual(
    columns.map((c) => c.name),
    [
      'execution_id',
      'job_id',
      'job_name',
      'scheduled_for',
      'status',
      'response_json',
      'claimed_at',
      'completed_at',
    ],
  );
  assert.equal(columns.find((c) => c.name === 'execution_id')?.pk, 1);
  assert.equal(columns.find((c) => c.name === 'response_json')?.notnull, 0);
  assert.equal(columns.find((c) => c.name === 'completed_at')?.notnull, 0);
});

test('无前缀迁移文件生成内容与 schema_v3 对应（0003）', () => {
  const migration = getMigrations('').find((m) => m.name === 'schema_v3');
  assert.equal(migration?.fileName, '0003_waker_executions.sql');
});
