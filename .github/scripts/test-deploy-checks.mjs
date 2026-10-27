// 在仓库根目录运行：node --test .github/scripts/test-deploy-checks.mjs
// HTTP 检查使用真实本地服务；控制面检查用固定响应模拟 Wrangler，不调用生产 API。
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  {
    // 密钥闸门：版本上没有 secret_text 的 JWT_SECRET 必须失败。
    name: '缺 JWT_SECRET 的 secret 绑定必须失败',
    version: 'uploaded',
    percentage: 100,
    prefix: 'hop',
    env: 'hop',
    secretBindings: [
      '{"name":"SETUP_SECRET","type":"secret_text"}',
      '{"name":"TOTP_ENCRYPTION_KEY","type":"secret_text"}',
    ],
    expectError:
      '::error::.*no secret_text binding for: JWT_SECRET\\. The deploy',
    ok: false,
  },
  {
    // 有同名绑定但不是 secret_text（例如在控制台手工加成了普通变量）也算缺。
    name: 'TOTP_ENCRYPTION_KEY 只是 plain_text 必须失败',
    version: 'uploaded',
    percentage: 100,
    prefix: 'hop',
    env: 'hop',
    secretBindings: [
      '{"name":"JWT_SECRET","type":"secret_text"}',
      '{"name":"SETUP_SECRET","type":"secret_text"}',
      '{"name":"TOTP_ENCRYPTION_KEY","type":"plain_text","text":""}',
    ],
    expectError: '::error::.*TOTP_ENCRYPTION_KEY',
    ok: false,
  },
]) {
  test(`控制面：${scenario.name}`, (t) => {
    const f = fixture(t);
    // 默认：三个运行时密钥都作为 secret_text 绑在版本上（就是修复后
    // --secrets-file 生效的模样）；负例按需换成缺项 / 错类型的列表。
    const secretBindings = (
      scenario.secretBindings ?? [
        '{"name":"JWT_SECRET","type":"secret_text"}',
        '{"name":"SETUP_SECRET","type":"secret_text"}',
        '{"name":"TOTP_ENCRYPTION_KEY","type":"secret_text"}',
      ]
    ).join(',');
    writeFileSync(
      join(f.dir, 'pnpm'),
      `#!/bin/sh
case "$*" in
  'exec wrangler deployments status --json')
    printf '%s\\n' '{"versions":[{"version_id":"${scenario.version}","percentage":${scenario.percentage}}]}' ;;
  'exec wrangler versions view uploaded --json'|'exec wrangler versions view uploaded --name hop --json')
    printf '%s\\n' '{"id":"uploaded","resources":{"bindings":[{"name":"TABLE_PREFIX","type":"plain_text","text":"${scenario.prefix}"},${secretBindings}]}}' ;;
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
      assert.match(stdout, /Secret bindings on version uploaded/);
    } else {
      let thrown = null;
      try {
        run();
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown, '必须失败');
      const output = `${thrown.stdout ?? ''}${thrown.stderr ?? ''}`;
      assert.match(
        output,
        new RegExp(scenario.expectError ?? '::error::'),
        output,
      );
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

// ─── 改动 E：未配置 APP_URL 时自动推导 workers.dev 地址 ───────────────────────

// 测试用 curl：本地 mock，不访问网络，两个 Cloudflare API 端点与冒烟探测都由
// 它回答；请求 URL 记进 requests.log，测试据此断言真的请求了推导出的地址。
function curlMock(
  dir,
  {
    subdomain = 'demo-sub',
    enabled = true,
    scriptOk = true,
    accountOk = true,
  } = {},
) {
  const failure = JSON.stringify({
    success: false,
    result: null,
    errors: [{ code: 10000, message: 'Authentication error' }],
  });
  const scriptBody = scriptOk
    ? JSON.stringify({
        success: true,
        result: { enabled, previews_enabled: false },
        errors: [],
      })
    : failure;
  const accountBody = accountOk
    ? JSON.stringify({ success: true, result: { subdomain }, errors: [] })
    : failure;
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/sh
out=""; hdr=""; url=""; prev=""
for a in "$@"; do
  case "$prev" in
    -o) out="$a" ;;
    -D) hdr="$a" ;;
  esac
  case "$a" in
    http*) url="$a" ;;
  esac
  prev="$a"
done
printf '%s\\n' "$url" >> ${join(dir, 'requests.log')}
case "$url" in
  */accounts/*/workers/scripts/*/subdomain) body='${scriptBody}' ;;
  */accounts/*/workers/subdomain) body='${accountBody}' ;;
  */api/health) body='{"status":"ok"}' ;;
  */api/config) body='{"appName":"Hop"}' ;;
  *) body='<html>Hop</html>' ;;
esac
if [ -n "$out" ]; then
  if [ -n "$hdr" ]; then : > "$hdr"; fi
  printf '%s' "$body" > "$out"
  printf '200'
else
  printf '%s' "$body"
fi
`,
    { mode: 0o755 },
  );
}

function requests(dir) {
  try {
    return readFileSync(join(dir, 'requests.log'), 'utf8')
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 清掉真实环境里可能存在的部署变量，只保留用例显式给的值。
async function runSmoke(f, extra) {
  const env = { ...f.env };
  for (const name of [
    'APP_URL',
    'ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'CHECK_DB',
  ]) {
    delete env[name];
  }
  Object.assign(env, extra);
  return exec('bash', [join(scripts, 'smoke-test.sh')], { env }).then(
    (r) => ({ ok: true, output: r.stdout + r.stderr }),
    (e) => ({ ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }),
  );
}

const creds = {
  ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'not-a-real-token',
};

test('冒烟：未配置 APP_URL 时用 CF API 推导 workers.dev 地址并探测', async (t) => {
  const f = fixture(t);
  curlMock(f.dir);
  const result = await runSmoke(f, { ...creds, CHECK_DB: 'true' });
  assert.equal(result.ok, true, result.output);
  assert.match(
    result.output,
    /Resolved workers\.dev address: https:\/\/hop\.demo-sub\.workers\.dev/,
  );
  const urls = requests(f.dir);
  assert.deepEqual(
    urls.filter((url) => url.startsWith('https://api.cloudflare.com/')),
    [
      `https://api.cloudflare.com/client/v4/accounts/${creds.ACCOUNT_ID}/workers/scripts/hop/subdomain`,
      `https://api.cloudflare.com/client/v4/accounts/${creds.ACCOUNT_ID}/workers/subdomain`,
    ],
    '两个 CF API 端点都应按同一 Worker 名与账户 ID 调用',
  );
  assert.deepEqual(
    urls.filter((url) => !url.startsWith('https://api.cloudflare.com/')),
    [
      'https://hop.demo-sub.workers.dev/api/health',
      'https://hop.demo-sub.workers.dev/',
      'https://hop.demo-sub.workers.dev/api/config',
    ],
    '探测必须打在推导出的 workers.dev 地址上',
  );
  assert.doesNotMatch(result.output, /::warning::/);
});

test('冒烟：APP_URL 已配置时优先探测它，不调用 CF API', async (t) => {
  const f = fixture(t);
  curlMock(f.dir);
  const result = await runSmoke(f, {
    ...creds,
    APP_URL: 'https://links.example.com/',
  });
  assert.equal(result.ok, true, result.output);
  const urls = requests(f.dir);
  assert.deepEqual(
    urls,
    ['https://links.example.com/api/health', 'https://links.example.com/'],
    '配了 APP_URL 就只探它（含去除尾部斜杠）',
  );
  assert.doesNotMatch(result.output, /Resolved workers\.dev address/);
});

test('冒烟：workers.dev 被关闭时报「未启用」而不是应用故障', async (t) => {
  const f = fixture(t);
  curlMock(f.dir, { enabled: false });
  const result = await runSmoke(f, creds);
  assert.equal(result.ok, false, result.output);
  assert.match(
    result.output,
    /::error::workers\.dev is not enabled for Worker 'hop'/,
  );
  assert.match(result.output, /not an application failure/);
  // 未启用时不做无意义的探测。
  assert.deepEqual(
    requests(f.dir).filter((url) => url.includes('workers.dev')),
    [],
  );
});

test('冒烟：读不到 workers.dev 开关只警告，仍按推导地址探测', async (t) => {
  const f = fixture(t);
  curlMock(f.dir, { scriptOk: false });
  const result = await runSmoke(f, creds);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /::warning::Could not read whether Worker/);
  assert.deepEqual(
    requests(f.dir).filter((url) => url.includes('/api/health')),
    ['https://hop.demo-sub.workers.dev/api/health'],
  );
});

test('冒烟：CF API 取不到子域名时报错并提示所需权限', async (t) => {
  const f = fixture(t);
  curlMock(f.dir, { accountOk: false });
  const result = await runSmoke(f, creds);
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /workers\/subdomain failed/);
  assert.match(result.output, /Workers Scripts:Read/);
  assert.doesNotMatch(result.output, /not-a-real-token/);
});

test('冒烟：APP_URL 与凭证都没有时报错', async (t) => {
  const f = fixture(t);
  curlMock(f.dir);
  const result = await runSmoke(f, {});
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /Neither vars\.APP_URL nor/);
  assert.deepEqual(requests(f.dir), [], '缺少凭证时不应发出任何请求');
});

test('deploy.yml：Smoke 步给自动推导补上 token 与账户 ID', () => {
  const lines = readFileSync(
    join(repoRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8',
  ).split('\n');
  const start = lines.findIndex((line) => line.trim() === '- name: Smoke test');
  assert.notEqual(start, -1, 'deploy.yml 缺少 Smoke 步');
  // 到下一个步骤声明为止，就是 Smoke 步本身的整段内容。
  const end = lines.findIndex(
    (line, i) => i > start && /^\s*- (name|uses):/.test(line),
  );
  const smoke = lines.slice(start, end === -1 ? lines.length : end).join('\n');
  assert.match(
    smoke,
    /^ {10}APP_URL: \$\{\{ vars\.APP_URL \}\}$/m,
    'APP_URL 仍是可选变量，原样传入',
  );
  assert.match(
    smoke,
    /^ {10}ACCOUNT_ID: \$\{\{ secrets\.[A-Z0-9_]+ \}\}$/m,
    '自动推导需要账户 ID',
  );
  assert.match(
    smoke,
    /^ {10}CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}$/m,
    '自动推导需要 API token',
  );
  assert.match(smoke, /^ {8}run: bash \.github\/scripts\/smoke-test\.sh$/m);
});

// ─── 改动 F：TOTP_ENCRYPTION_KEY 改由 GitHub Actions 写入 secrets 文件 ────────

// 执行 deploy.yml 里真实的 Write secrets file 步：取值、必填校验与落盘都走
// workflow 自身，位置与格式不在测试里重写一份。
function runWriteSecrets(f, values) {
  const runnerTemp = join(f.dir, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });
  const env = { ...f.env, RUNNER_TEMP: runnerTemp };
  for (const name of ['JWT_SECRET', 'SETUP_SECRET', 'TOTP_ENCRYPTION_KEY']) {
    delete env[name];
  }
  Object.assign(env, values);
  const secretsPath = join(runnerTemp, 'secrets.json');
  try {
    execFileSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        stepScript('Write secrets file'),
      ],
      { cwd: f.dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    return {
      ok: false,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      secretsPath,
    };
  }
  return { ok: true, output: '', secretsPath };
}

// 测试专用假值：只验证键名与接线，绝不涉及任何真实密钥。
const fakeSecrets = {
  JWT_SECRET: 'test-jwt-not-a-real-value',
  SETUP_SECRET: 'test-setup-not-a-real-value',
  TOTP_ENCRYPTION_KEY: 'test-totp-not-a-real-value',
};

test('secrets 文件：三键齐全时含 TOTP_ENCRYPTION_KEY', (t) => {
  const f = fixture(t);
  const result = runWriteSecrets(f, fakeSecrets);
  assert.equal(result.ok, true, result.output);
  const parsed = JSON.parse(readFileSync(result.secretsPath, 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), [
    'JWT_SECRET',
    'SETUP_SECRET',
    'TOTP_ENCRYPTION_KEY',
  ]);
  assert.equal(parsed.TOTP_ENCRYPTION_KEY, fakeSecrets.TOTP_ENCRYPTION_KEY);
  // 仍只在 $RUNNER_TEMP 落盘、权限 600。
  assert.equal(statSync(result.secretsPath).mode & 0o777, 0o600);
});

test('secrets 文件：缺 TOTP_ENCRYPTION_KEY 时该步失败且不继续', (t) => {
  const f = fixture(t);
  const values = { ...fakeSecrets };
  delete values.TOTP_ENCRYPTION_KEY;
  const result = runWriteSecrets(f, values);
  assert.equal(result.ok, false, '缺键必须失败关闭');
  assert.match(
    result.output,
    /::error::GitHub Secret 'TOTP_ENCRYPTION_KEY' is empty or missing/,
    result.output,
  );
  // 没有 secrets 文件，后续 Deploy 步拿不到 --secrets-file，部署不会继续。
  assert.equal(existsSync(result.secretsPath), false);
});

test('deploy.yml：Write secrets file 步从仓库 Secret 注入 TOTP_ENCRYPTION_KEY', () => {
  const lines = readFileSync(
    join(repoRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8',
  ).split('\n');
  const start = lines.findIndex(
    (line) => line.trim() === '- name: Write secrets file',
  );
  assert.notEqual(start, -1, 'deploy.yml 缺少 Write secrets file 步');
  const end = lines.findIndex(
    (line, i) => i > start && /^\s*- (name|uses):/.test(line),
  );
  const step = lines.slice(start, end === -1 ? lines.length : end).join('\n');
  assert.match(
    step,
    /^ {10}TOTP_ENCRYPTION_KEY: \$\{\{ secrets\.TOTP_ENCRYPTION_KEY \}\}$/m,
    'TOTP_ENCRYPTION_KEY 必须取自仓库 Secret，与 JWT_SECRET 同路',
  );
  // 与 JWT_SECRET/SETUP_SECRET 同规格：必填校验清单里点名。
  assert.match(
    step,
    /for name in JWT_SECRET SETUP_SECRET TOTP_ENCRYPTION_KEY; do/,
    '必填校验须覆盖该键',
  );
});

// ─── 改动 B：Deploy 步让 --secrets-file 真正到达 Wrangler ─────────────────────

test('deploy.yml：Deploy 步直接调 Wrangler 传 --secrets-file', () => {
  const lines = readFileSync(
    join(repoRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8',
  ).split('\n');
  const start = lines.findIndex((line) => line.trim() === '- name: Deploy');
  assert.notEqual(start, -1, 'deploy.yml 缺少 Deploy 步');
  const end = lines.findIndex(
    (line, i) => i > start && /^\s*- (name|uses):/.test(line),
  );
  const step = lines.slice(start, end === -1 ? lines.length : end).join('\n');
  // `pnpm run deploy -- --secrets-file` 会把字面 `--` 转发给脚本，Wrangler 的
  // yargs 随后把其后的参数当位置参数丢掉，密钥因此从未上传（ONE-563 根因）。
  assert.doesNotMatch(
    step,
    /pnpm run deploy --\s/,
    '不能再经过 pnpm 的 `--` 转发',
  );
  assert.match(
    step,
    /run: pnpm exec wrangler deploy --secrets-file "\$RUNNER_TEMP\/secrets\.json"/,
    'Deploy 步必须由 Wrangler 自己收到 --secrets-file',
  );
});
