// 在仓库根目录运行：node --test .github/scripts/test-deploy-checks.mjs
// HTTP 检查使用真实本地服务；控制面检查用固定响应模拟 Wrangler，不调用生产 API。
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const exec = promisify(execFile);

// 取出 deploy.yml 里真实步骤的 run 脚本执行：测试跑的就是 workflow 本身，
// 不复制、不另写一份等价逻辑。
function stepScript(name) {
  const lines = readFileSync(
    join(repoRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8',
  ).split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `deploy.yml 缺少步骤「${name}」`);
  const runAt = lines.findIndex(
    (line, i) => i > start && /^\s*run: \|\s*$/.test(line),
  );
  assert.ok(runAt > start, `步骤「${name}」缺少 run 脚本`);
  const blockIndent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && line.match(/^\s*/)[0].length <= blockIndent) {
      break;
    }
    body.push(line);
  }
  const bodyIndent = Math.min(
    ...body
      .filter((line) => line.trim() !== '')
      .map((line) => line.match(/^\s*/)[0].length),
  );
  return `${body.map((line) => line.slice(bodyIndent)).join('\n')}\n`;
}

// 部署 workflow 跑在 ubuntu 上，用 GNU sed 语法（`sed -i 's/x/y/' f`）；
// macOS 自带 BSD sed 要求 `-i` 带备份后缀。本地跑测试时补一层适配，
// 而不是为 macOS 去改 workflow。
function gnuSedShim(dir) {
  if (process.platform !== 'darwin') return;
  writeFileSync(
    join(dir, 'sed'),
    `#!/bin/sh
if command -v gsed >/dev/null 2>&1; then exec gsed "$@"; fi
if [ "$1" = "-i" ]; then shift; exec /usr/bin/sed -i '' "$@"; fi
exec /usr/bin/sed "$@"
`,
    { mode: 0o755 },
  );
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hop-deploy-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 仅跳过重试等待，不替换 curl 或 jq。
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return {
    dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  };
}

for (const scenario of [
  { name: '正常响应，包含数据库检查', code: 200, ok: true },
  {
    name: '403 challenge 仅警告，仍检查全部路径',
    code: 403,
    challenge: true,
    ok: true,
  },
  { name: '普通 403 必须失败', code: 403, ok: false },
  {
    name: '500 必须失败，即使有 challenge 头',
    code: 500,
    challenge: true,
    ok: false,
  },
  { name: '302 不得当成成功', code: 302, ok: false },
  {
    name: '200 但数据库响应错误必须失败',
    code: 200,
    badConfig: true,
    ok: false,
  },
]) {
  test(`冒烟：${scenario.name}`, async (t) => {
    const f = fixture(t);
    const paths = [];
    const server = createServer((req, res) => {
      paths.push(req.url);
      res.writeHead(
        scenario.code,
        scenario.challenge ? { 'Cf-Mitigated': 'challenge' } : {},
      );
      res.end(
        req.url === '/api/health'
          ? '{"status":"ok"}'
          : req.url === '/api/config'
            ? scenario.badConfig
              ? '{"error":"database unavailable"}'
              : '{"appName":"Hop"}'
            : '<html>Hop</html>',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await exec('bash', [join(scripts, 'smoke-test.sh')], {
      env: {
        ...f.env,
        APP_URL: `http://127.0.0.1:${server.address().port}`,
        CHECK_DB: 'true',
      },
    }).then(
      (r) => ({ ok: true, output: r.stdout }),
      (e) => ({ ok: false, output: e.stdout }),
    );
    assert.equal(result.ok, scenario.ok, result.output);
    if (scenario.ok) {
      assert.deepEqual(paths, ['/api/health', '/', '/api/config']);
      if (scenario.challenge) {
        assert.equal(result.output.match(/::warning::/g)?.length, 3);
        assert.doesNotMatch(result.output, /::error::/);
      }
    } else {
      assert.match(result.output, /::error::/);
    }
  });
}

for (const scenario of [
  {
    name: '本次上传版本承载 100% 流量',
    version: 'uploaded',
    percentage: 100,
    prefix: 'SL',
    ok: true,
  },
  {
    // 配置托管的默认前缀：CI 写入的绑定与 GitHub 变量解析结果一致。
    name: '配置托管默认前缀 hop 时通过',
    version: 'uploaded',
    percentage: 100,
    prefix: 'hop',
    env: 'hop',
    ok: true,
  },
  {
    // 配置托管的无前缀情形：绑定为空字符串，期望也是空字符串。
    name: '配置托管空字符串（none 无前缀）时通过',
    version: 'uploaded',
    percentage: 100,
    prefix: '',
    env: '',
    ok: true,
  },
  {
    name: '仍在运行旧版本',
    version: 'old',
    percentage: 100,
    prefix: 'SL',
    ok: false,
  },
  {
    name: '本次版本只承载部分流量',
    version: 'uploaded',
    percentage: 50,
    prefix: 'SL',
    ok: false,
  },
  {
    name: '版本正确但前缀不一致',
    version: 'uploaded',
    percentage: 100,
    prefix: 'ZETA',
    ok: false,
  },
  {
    name: '绑定为空但期望 hop 必须失败',
    version: 'uploaded',
    percentage: 100,
    prefix: '',
    env: 'hop',
    ok: false,
  },
  {
    name: '绑定为 hop 但期望无前缀必须失败',
    version: 'uploaded',
    percentage: 100,
    prefix: 'hop',
    env: '',
    ok: false,
  },
]) {
  test(`控制面：${scenario.name}`, (t) => {
    const f = fixture(t);
    writeFileSync(
      join(f.dir, 'pnpm'),
      `#!/bin/sh
case "$*" in
  'exec wrangler deployments status --json')
    printf '%s\\n' '{"versions":[{"version_id":"${scenario.version}","percentage":${scenario.percentage}}]}' ;;
  'exec wrangler versions view uploaded --json')
    printf '%s\\n' '{"id":"uploaded","resources":{"bindings":[{"name":"TABLE_PREFIX","type":"plain_text","text":"${scenario.prefix}"}]}}' ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const output = join(f.dir, 'deploy.ndjson');
    writeFileSync(output, '{"type":"deploy","version_id":"uploaded"}\n');
    const run = () =>
      execFileSync('bash', [join(scripts, 'verify-deployment.sh')], {
        env: {
          ...f.env,
          // 期望值（GitHub 变量解析结果）默认取 SL；用例可单独指定。
          TABLE_PREFIX: scenario.env ?? 'SL',
          WRANGLER_OUTPUT_FILE_PATH: output,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    if (scenario.ok) {
      const stdout = run();
      assert.match(stdout, /serves 100% of production traffic/);
      assert.ok(
        stdout.includes(`TABLE_PREFIX: ${scenario.prefix || '<none>'}`),
        stdout,
      );
    } else {
      assert.throws(run, /Command failed/);
    }
  });
}

// ─── CI 三态解析（none 约定）─────────────────────────────────────────────────

for (const scenario of [
  { name: 'vars 未设 → 默认 hop', env: undefined, expected: 'hop' },
  { name: 'vars 为空 → 默认 hop', env: '', expected: 'hop' },
  { name: 'vars 为保留字 none → 空字符串', env: 'none', expected: '' },
  { name: 'vars 为其他值 → 原样（含大小写）', env: 'SL', expected: 'SL' },
]) {
  test(`三态解析（none 约定）：${scenario.name}`, (t) => {
    const f = fixture(t);
    const env = { ...f.env };
    if (scenario.env === undefined) {
      delete env.TABLE_PREFIX;
    } else {
      env.TABLE_PREFIX = scenario.env;
    }
    const out = execFileSync(
      'node',
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        join(scripts, 'resolve-table-prefix.mjs'),
      ],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.equal(out, scenario.expected);
  });
}

test('worker-table-prefix.sh：未设置绑定 → 默认 hop', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.dir, 'pnpm'),
    `#!/bin/sh
case "$*" in
  'exec wrangler versions view v1 --json')
    printf '%s\\n' '{"id":"v1","resources":{"bindings":[]}}' ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  const out = execFileSync(
    'bash',
    [join(scripts, 'worker-table-prefix.sh'), 'v1'],
    { env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(out, 'hop');
});

// ─── 改动 A：CI 部署时把配置托管前缀写进 Worker 绑定 ─────────────────────────

test('wrangler.toml：声明配置托管的 TABLE_PREFIX 占位符', () => {
  const toml = readFileSync(
    join(repoRoot, 'apps', 'worker', 'wrangler.toml'),
    'utf8',
  );
  assert.match(toml, /^\[vars\]$/m);
  assert.match(toml, /^TABLE_PREFIX = "TABLE_PREFIX_PLACEHOLDER"$/m);
  // keep_vars 不变：控制台独有变量继续保留。
  assert.match(toml, /^keep_vars = true$/m);
});

test('deploy.yml：Resolve 步在 Inject 步之前', () => {
  const lines = readFileSync(
    join(repoRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8',
  ).split('\n');
  const stepAt = (name) =>
    lines.findIndex((line) => line.trim() === `- name: ${name}`);
  const resolve = stepAt('Resolve TABLE_PREFIX (three-state)');
  const inject = stepAt('Inject resource IDs');
  assert.ok(resolve !== -1 && inject !== -1, '步骤缺失');
  assert.ok(resolve < inject, 'Resolve 步必须在 Inject 步之前');
});

for (const scenario of [
  { name: 'vars 为 SL → 绑定 SL', env: 'SL', expected: 'SL' },
  { name: 'vars 未配 → 绑定默认 hop', env: undefined, expected: 'hop' },
  { name: 'vars 为 none → 绑定空字符串', env: 'none', expected: '' },
]) {
  test(`Inject：${scenario.name}`, (t) => {
    const f = fixture(t);
    gnuSedShim(f.dir);
    const tomlPath = join(f.dir, 'apps', 'worker', 'wrangler.toml');
    mkdirSync(join(f.dir, 'apps', 'worker'), { recursive: true });
    copyFileSync(join(repoRoot, 'apps', 'worker', 'wrangler.toml'), tomlPath);

    // 1) 与 workflow 的 Resolve 步同一命令解析三态前缀。
    const resolveEnv = { ...f.env };
    if (scenario.env === undefined) {
      delete resolveEnv.TABLE_PREFIX;
    } else {
      resolveEnv.TABLE_PREFIX = scenario.env;
    }
    const resolved = execFileSync(
      'node',
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        join(scripts, 'resolve-table-prefix.mjs'),
      ],
      {
        cwd: repoRoot,
        env: resolveEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.equal(resolved, scenario.expected);

    // 2) 执行 deploy.yml 里真实的 Inject 步脚本。资源 ID 用合法格式的假值，
    //    变量名从脚本自身的 check 调用里取，避免测试里重写一份校验清单。
    const script = stepScript('Inject resource IDs');
    const env = { ...f.env, TABLE_PREFIX: resolved };
    for (const [, name] of script.matchAll(/^\s*check\s+([A-Z0-9_]+)\s/gm)) {
      env[name] = '0'.repeat(32);
    }
    execFileSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
      { cwd: f.dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const toml = readFileSync(tomlPath, 'utf8');
    assert.match(
      toml,
      new RegExp(`^TABLE_PREFIX = "${scenario.expected}"$`, 'm'),
    );
    // 残留检查（Inject 步的 grep）通过：所有占位符都已替换。
    assert.doesNotMatch(toml, /_PLACEHOLDER/);
  });
}
