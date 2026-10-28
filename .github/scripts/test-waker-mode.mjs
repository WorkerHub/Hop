// Tests for .github/scripts/configure-waker-mode.mjs — the deploy-time rewrite
// that turns the one wrangler.toml into the cron or the waker build.
//
// The most important assertion is the "cron stays as it was" one: with no waker
// variables configured, the generated config must equal the committed file plus
// exactly one explicit `WAKER_MODE = "cron"` line (needed because keep_vars=true
// would otherwise let a previous waker value survive), with [triggers] intact.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = join(scripts, 'configure-waker-mode.mjs');
const committedToml = readFileSync(
  join(repoRoot, 'apps', 'worker', 'wrangler.toml'),
  'utf8',
);

const MANAGED = ['WAKER_MODE', 'WAKER_URL', 'WAKER_TRIGGERS'];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hop-waker-mode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const toml = join(dir, 'wrangler.toml');
  copyFileSync(join(repoRoot, 'apps', 'worker', 'wrangler.toml'), toml);
  const githubOutput = join(dir, 'github-output');
  const baseEnv = { ...process.env };
  for (const name of MANAGED) delete baseEnv[name];
  return {
    toml,
    githubOutput,
    run(env = {}) {
      const runEnv = {
        ...baseEnv,
        WRANGLER_TOML: toml,
        GITHUB_OUTPUT: githubOutput,
        ...env,
      };
      try {
        const stdout = execFileSync(
          'node',
          ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', scriptPath],
          { env: runEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        return {
          ok: true,
          stdout,
          toml: readFileSync(toml, 'utf8'),
          output: readFileSync(githubOutput, 'utf8'),
        };
      } catch (error) {
        return {
          ok: false,
          output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
        };
      }
    },
  };
}

// ─── cron (default): [triggers] untouched, one explicit mode var ─────────────

for (const scenario of [
  { name: '所有 waker 变量都未配置', env: {} },
  { name: 'WAKER_MODE=cron（显式）', env: { WAKER_MODE: 'cron' } },
  {
    name: 'WAKER_MODE=cron + WAKER_TRIGGERS=keep',
    env: { WAKER_MODE: 'cron', WAKER_TRIGGERS: 'keep' },
  },
]) {
  test(`cron 模式（${scenario.name}）→ 配置与迁移前一致，只多一行 WAKER_MODE=cron`, (t) => {
    const f = fixture(t);
    const result = f.run(scenario.env);
    assert.equal(result.ok, true, result.output);

    const expected = committedToml.replace(
      '[vars]\n',
      '[vars]\nWAKER_MODE = "cron"\n',
    );
    assert.equal(
      result.toml,
      expected,
      '除了显式 WAKER_MODE 不得有任何其他改动',
    );

    // [triggers] 原样保留：同一表达式、只此一条。
    assert.match(result.toml, /^crons = \["0 3 \* \* \*"\]$/m);
    assert.equal((result.toml.match(/^crons\s*=/gm) ?? []).length, 1);
    assert.doesNotMatch(result.toml, /^WAKER_URL\s*=/m);
    assert.equal(result.output.trim(), 'mode=cron\ntriggers=keep');
  });
}

// ─── waker: [triggers] removed, WAKER_URL injected ───────────────────────────

test('waker 模式默认 keep（双跑），triggers 保留', (t) => {
  const f = fixture(t);
  const result = f.run({
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://waker.oneboy.app',
  });
  assert.equal(result.ok, true, result.output);
  assert.match(
    result.toml,
    /^\[triggers\]\n(?:#[^\n]*\n)*crons = \["0 3 \* \* \*"\]$/m,
  );
  assert.match(result.toml, /^WAKER_MODE = "waker"$/m);
  assert.equal(
    result.output.trim(),
    'mode=waker\ntriggers=keep\nurl=https://waker.oneboy.app',
  );
});

test('waker 模式 + WAKER_TRIGGERS=remove → 删除 [triggers]、写入 WAKER_MODE/WAKER_URL', (t) => {
  const f = fixture(t);
  const result = f.run({
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://waker.oneboy.app/',
    WAKER_TRIGGERS: 'remove',
  });
  assert.equal(result.ok, true, result.output);
  assert.doesNotMatch(result.toml, /^\[triggers\]$/m);
  assert.doesNotMatch(result.toml, /^crons\s*=/m);
  assert.match(result.toml, /^WAKER_MODE = "waker"$/m);
  // Trailing slash trimmed so the value is the platform's base URL.
  assert.match(result.toml, /^WAKER_URL = "https:\/\/waker\.oneboy\.app"$/m);
  // The resource-ID placeholders are left for the injection step / sed.
  assert.match(result.toml, /TABLE_PREFIX = "TABLE_PREFIX_PLACEHOLDER"/);
  assert.match(result.toml, /database_id = "D1_DATABASE_ID_PLACEHOLDER"/);
  assert.equal(
    result.output.trim(),
    'mode=waker\ntriggers=remove\nurl=https://waker.oneboy.app',
  );
});

test('waker 模式 + WAKER_TRIGGERS=keep → 双跑过渡态（receiver 开、triggers 留）', (t) => {
  const f = fixture(t);
  const result = f.run({
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://waker.oneboy.app',
    WAKER_TRIGGERS: 'keep',
  });
  assert.equal(result.ok, true, result.output);
  assert.match(
    result.toml,
    /^\[triggers\]\n(?:#[^\n]*\n)*crons = \["0 3 \* \* \*"\]$/m,
  );
  assert.match(result.toml, /^WAKER_MODE = "waker"$/m);
  assert.match(result.toml, /^WAKER_URL = "https:\/\/waker\.oneboy\.app"$/m);
  assert.match(result.stdout, /dual run/);
});

test('waker 模式变量大小写与空白被规范化', (t) => {
  const f = fixture(t);
  const result = f.run({
    WAKER_MODE: ' WAKER ',
    WAKER_URL: ' https://waker.oneboy.app ',
  });
  assert.equal(result.ok, true, result.output);
  assert.match(result.toml, /^WAKER_MODE = "waker"$/m);
});

test('重复运行同一文件是幂等的（不重复写 WAKER_MODE / WAKER_URL）', (t) => {
  const f = fixture(t);
  const first = f.run({
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://waker.oneboy.app',
  });
  assert.equal(first.ok, true, first.output);
  const second = f.run({
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://waker.oneboy.app',
  });
  assert.equal(second.ok, true, second.output);
  assert.equal(second.toml, first.toml);
  assert.equal((second.toml.match(/^WAKER_MODE\s*=/gm) ?? []).length, 1);
  assert.equal((second.toml.match(/^WAKER_URL\s*=/gm) ?? []).length, 1);
});

test('从 waker 模式切回 cron 模式：triggers 恢复、WAKER_URL 不再写入', (t) => {
  const f = fixture(t);
  const waker = f.run({
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://waker.oneboy.app',
  });
  assert.equal(waker.ok, true, waker.output);
  // 回滚时仓库是全新的，这里先还原成提交版再跑 cron，模拟下一次干净部署。
  copyFileSync(join(repoRoot, 'apps', 'worker', 'wrangler.toml'), f.toml);
  const cron = f.run({ WAKER_MODE: 'cron' });
  assert.equal(cron.ok, true, cron.output);
  assert.match(
    cron.toml,
    /^\[triggers\]\n(?:#[^\n]*\n)*crons = \["0 3 \* \* \*"\]$/m,
  );
  assert.doesNotMatch(cron.toml, /^WAKER_URL\s*=/m);
});

// ─── invalid combinations fail closed ───────────────────────────────────────

test('waker 模式缺 WAKER_URL → 部署失败（不留下半配置的回调入口）', (t) => {
  const f = fixture(t);
  const result = f.run({ WAKER_MODE: 'waker' });
  assert.equal(result.ok, false);
  assert.match(result.output, /::error::WAKER_MODE=waker requires WAKER_URL/);
});

test('WAKER_URL 含引号/空白 → 部署失败', (t) => {
  const f = fixture(t);
  const result = f.run({
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://waker.oneboy.app "quoted"',
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /not a plain http\(s\) URL/);
});

test('WAKER_MODE 取值未知 → 部署失败（不静默按 cron 部署）', (t) => {
  const f = fixture(t);
  const result = f.run({ WAKER_MODE: 'wakr' });
  assert.equal(result.ok, false);
  assert.match(result.output, /WAKER_MODE="wakr" is invalid/);
});

test('WAKER_TRIGGERS 取值未知 → 部署失败', (t) => {
  const f = fixture(t);
  const result = f.run({
    WAKER_MODE: 'waker',
    WAKER_URL: 'https://w.example',
    WAKER_TRIGGERS: 'pause',
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /WAKER_TRIGGERS="pause" is invalid/);
});

test('cron 模式 + WAKER_TRIGGERS=remove → 部署失败（否则没有任何调度器）', (t) => {
  const f = fixture(t);
  const result = f.run({ WAKER_MODE: 'cron', WAKER_TRIGGERS: 'remove' });
  assert.equal(result.ok, false);
  assert.match(result.output, /would leave the app without any scheduler/);
});

// ─── repo-level cron invariant ───────────────────────────────────────────────

test('全仓唯一的 cron 表达式仍是 0 3 * * *，且与 waker 任务参数逐字一致', () => {
  assert.equal((committedToml.match(/^crons\s*=/gm) ?? []).length, 1);
  assert.match(committedToml, /^crons = \["0 3 \* \* \*"\]$/m);

  const service = readFileSync(
    join(repoRoot, 'apps', 'worker', 'src', 'services', 'waker.ts'),
    'utf8',
  );
  assert.match(service, /WAKER_JOB_CRON = '0 3 \* \* \*'/);
  assert.match(service, /WAKER_JOB_NIGHTLY_CLEANUP = 'nightly-cleanup'/);
});
