// Static invariants of the simplified waker wiring: the scheduling config is
// static, the signing key is the only switch, and no deployment variable from
// the old dual-mode design survived anywhere in the pipeline.
//
// Run from the repository root:
//   node --test .github/scripts/test-waker-deploy.mjs
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

const wranglerToml = read('apps', 'worker', 'wrangler.toml');
const deployYml = read('.github', 'workflows', 'deploy.yml');
const turboJson = read('turbo.json');
const verifyScript = read('.github', 'scripts', 'verify-deployment.sh');

const SELF = fileURLToPath(import.meta.url);

/** Every pipeline file (workflows + deploy scripts), used for the residue scan. */
function pipelineFiles(dir = join(repoRoot, '.github')) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...pipelineFiles(full));
    else if (
      /\.(ya?ml|mjs|sh)$/.test(entry.name) &&
      full !== SELF &&
      // Test files naturally name what they assert is absent; they are not
      // pipeline configuration.
      !/^test-.*\.mjs$/.test(entry.name)
    ) {
      files.push(full);
    }
  }
  return files;
}

// ─── [triggers] is static: the native Cron Trigger is always deployed ────────

test('wrangler.toml 的 [triggers] 静态保留，全仓唯一 cron 表达式仍是 0 3 * * *', () => {
  assert.match(wranglerToml, /^\[triggers\]$/m);
  assert.match(wranglerToml, /^crons = \["0 3 \* \* \*"\]$/m);
  assert.equal(
    (wranglerToml.match(/^crons\s*=/gm) ?? []).length,
    1,
    '只允许一条 crons 声明',
  );

  // 任务名与表达式与 waker 管理面注册的参数逐字一致。
  const service = read('apps', 'worker', 'src', 'services', 'waker.ts');
  assert.match(service, /WAKER_JOB_CRON = '0 3 \* \* \*'/);
  assert.match(service, /WAKER_JOB_NIGHTLY_CLEANUP = 'nightly-cleanup'/);
});

test('wrangler.toml 不含任何 WAKER_ 变量（启停只认 secrets 里的 signing key）', () => {
  assert.doesNotMatch(wranglerToml, /WAKER_/);
});

test('流水线不重写 [triggers]：deploy.yml 里没有 triggers 处理，也没有摘除脚本', () => {
  assert.doesNotMatch(deployYml, /triggers/i);
  // 旧的双模式改写脚本已删除，且 .github/scripts 里没有替代品。
  assert.equal(
    existsSync(
      join(repoRoot, '.github', 'scripts', 'configure-waker-mode.mjs'),
    ),
    false,
    'configure-waker-mode.mjs 必须删除',
  );
  for (const file of pipelineFiles()) {
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /stripTriggers|configure-waker-mode/,
      `${file} 仍在处理 triggers`,
    );
  }
});

// ─── the three mode variables are gone from the whole pipeline ──────────────

test('流水线（workflows + scripts）无 WAKER_MODE / WAKER_URL / WAKER_TRIGGERS 残留', () => {
  for (const file of pipelineFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const name of ['WAKER_MODE', 'WAKER_URL', 'WAKER_TRIGGERS']) {
      assert.doesNotMatch(text, new RegExp(name), `${file} 仍引用 ${name}`);
    }
  }
});

test('turbo.json 的 env 名单不再有 waker 模式变量，TABLE_PREFIX 仍透传', () => {
  const turbo = JSON.parse(turboJson);
  const names = turbo.globalPassThroughEnv ?? [];
  assert.deepEqual(
    names.filter((name) => name.startsWith('WAKER_')),
    [],
    'globalPassThroughEnv 不得再列 WAKER_*',
  );
  assert.ok(names.includes('TABLE_PREFIX'), 'TABLE_PREFIX 必须继续透传');
});

// ─── deploy: one optional Secret, injected when present ─────────────────────

function step(name) {
  const lines = deployYml.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `deploy.yml 缺少步骤「${name}」`);
  const end = lines.findIndex(
    (line, i) => i > start && /^\s*- (name|uses):/.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

test('deploy.yml：signing key 只从仓库 Secret 取，绝不来自明文变量', () => {
  assert.match(
    deployYml,
    /WAKER_SIGNING_KEY: \$\{\{ secrets\.WAKER_SIGNING_KEY \}\}/,
  );
  assert.doesNotMatch(deployYml, /WAKER_SIGNING_KEY: \$\{\{ vars\./);
});

test('deploy.yml：secrets 文件步可选注入 key，并把解析状态交给 Verify 步', () => {
  const secretsStep = step('Write secrets file');
  assert.match(secretsStep, /^ {8}id: secrets$/m);
  // 必填清单只有与模式无关的三把密钥：signing key 缺失不拦部署（接收端 fail closed）。
  assert.match(
    secretsStep,
    /for name in JWT_SECRET SETUP_SECRET TOTP_ENCRYPTION_KEY; do/,
  );
  assert.match(secretsStep, /waker_signing_key/);
  assert.match(
    secretsStep,
    /const key = \(process\.env\.WAKER_SIGNING_KEY \?\? ""\)\.trim\(\)/,
  );
  assert.match(secretsStep, /secrets\.WAKER_SIGNING_KEY = key/);

  const verifyStep = step('Verify deployment');
  assert.match(
    verifyStep,
    /^ {10}WAKER_SIGNING_KEY_EXPECTED: \$\{\{ steps\.secrets\.outputs\.waker_signing_key \}\}$/m,
  );

  // 顺序：先解析并落盘 secrets，再部署，最后核对绑定。
  const lines = deployYml.split('\n');
  const at = (name) =>
    lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(at('Write secrets file') < at('Deploy'));
  assert.ok(at('Deploy') < at('Verify deployment'));
});

test('verify-deployment.sh：无模式变量，cron 排期恒为 0 3 * * *', () => {
  assert.doesNotMatch(verifyScript, /WAKER_MODE|WAKER_TRIGGERS/);
  assert.match(verifyScript, /WAKER_SIGNING_KEY_EXPECTED/);
  assert.match(
    verifyScript,
    /expected exactly '0 3 \* \* \*'/,
    '排期闸门必须要求原生 Cron Trigger 在场',
  );
});
