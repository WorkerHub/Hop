// 在仓库根目录运行：node --test .github/scripts/test-deploy-checks.mjs
// HTTP 检查使用真实本地服务；控制面检查用固定响应模拟 Wrangler，不调用生产 API。
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const exec = promisify(execFile);

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
          TABLE_PREFIX: 'SL',
          WRANGLER_OUTPUT_FILE_PATH: output,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    if (scenario.ok) {
      assert.match(run(), /serves 100% of production traffic/);
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
