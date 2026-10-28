// Deploy-time configuration of the optional waker mode.
//
// The deploy workflow runs this after the resource-ID injection step and before
// the build, so the uploaded version is configured exactly as the GitHub
// variables say:
//
//   WAKER_MODE=cron   (default) native CF Cron Trigger — `[triggers]` stays,
//                     WAKER_MODE="cron" is written explicitly (keep_vars=true
//                     would otherwise leave a previous `waker` value alive),
//                     no WAKER_URL, no WAKER_SIGNING_KEY is injected.
//   WAKER_MODE=waker  waker callback mode — WAKER_MODE="waker" and WAKER_URL
//                     are written. `[triggers]` is removed only with an
//                     explicit WAKER_TRIGGERS=remove (the switch action);
//                     the default `keep` is the dual-run state: receiver on,
//                     native trigger still firing.
//
// Nothing secret is read or written here: WAKER_URL is plain configuration and
// WAKER_SIGNING_KEY never appears in wrangler.toml (the workflow puts it in the
// --secrets-file only).
//
// Usage (from the repository root):
//   node .github/scripts/configure-waker-mode.mjs
// Env: WAKER_MODE (cron|waker), WAKER_URL, WAKER_TRIGGERS (keep|remove, keep by
//      default), WRANGLER_TOML (optional path override), GITHUB_OUTPUT.
//
// Prints `mode=…` / `triggers=…` to $GITHUB_OUTPUT for later workflow steps.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_TOML = 'apps/worker/wrangler.toml';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readEnum(name, raw, allowed, fallback) {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (!allowed.includes(value)) {
    fail(
      `${name}=${JSON.stringify(raw)} is invalid; expected one of: ${allowed.join(', ')}`,
    );
  }
  return value;
}

const mode = readEnum(
  'WAKER_MODE',
  process.env.WAKER_MODE,
  ['cron', 'waker'],
  'cron',
);
const triggers = readEnum(
  'WAKER_TRIGGERS',
  process.env.WAKER_TRIGGERS,
  ['keep', 'remove'],
  'keep',
);

// A cron-mode deploy that removes the native triggers would leave the app with
// no scheduler at all. Refuse instead of silently deploying that state.
if (mode === 'cron' && triggers === 'remove') {
  fail(
    'WAKER_MODE=cron with WAKER_TRIGGERS=remove would leave the app without any scheduler; ' +
      'use WAKER_MODE=waker to remove [triggers], or WAKER_TRIGGERS=keep.',
  );
}

let url = '';
if (mode === 'waker') {
  url = (process.env.WAKER_URL ?? '').trim().replace(/\/+$/, '');
  if (url === '') {
    fail(
      'WAKER_MODE=waker requires WAKER_URL (the platform base URL, e.g. https://waker.oneboy.app). ' +
        'It is plain configuration: set it as a GitHub variable.',
    );
  }
  if (!/^https?:\/\/[^\s"'\\]+$/.test(url)) {
    fail(
      `WAKER_URL=${JSON.stringify(process.env.WAKER_URL)} is not a plain http(s) URL; ` +
        'it must not contain whitespace, quotes or backslashes.',
    );
  }
}

const tomlPath = process.env.WRANGLER_TOML ?? DEFAULT_TOML;
let toml;
try {
  toml = readFileSync(tomlPath, 'utf8');
} catch (error) {
  fail(`cannot read ${tomlPath}: ${error.message}`);
}

// ─── [triggers] ──────────────────────────────────────────────────────────────

function hasTriggers(text) {
  return (
    /^\[triggers\]\s*$/m.test(text) && /^crons\s*=\s*\[.*\]\s*$/m.test(text)
  );
}

function stripTriggers(text) {
  // The [triggers] block is the last table in hop's wrangler.toml. Header and
  // body (comments included) are dropped; a table header that follows (if one
  // is ever added) is kept, along with everything after it.
  const out = [];
  let inTriggers = false;
  for (const line of text.split('\n')) {
    if (/^\s*\[triggers\]\s*$/.test(line)) {
      inTriggers = true;
      continue;
    }
    if (inTriggers) {
      // The block ends at the next table header; blank lines and comments that
      // belonged to it are dropped with it.
      if (/^\s*\[/.test(line)) {
        inTriggers = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

if (triggers === 'keep') {
  if (!hasTriggers(toml)) {
    fail(
      `${tomlPath} has no [triggers] block with a crons entry, but WAKER_TRIGGERS=keep ` +
        'requires the native Cron Trigger to stay. Restore the section in the repository.',
    );
  }
} else {
  toml = stripTriggers(toml);
}

// ─── [vars] ──────────────────────────────────────────────────────────────────
// Managed entries are rewritten on every run so a value from an earlier mode
// can never survive inside the file itself. (keep_vars=true in wrangler.toml is
// why WAKER_MODE must always be written, even in cron mode.)

if (!/^\[vars\]\s*$/m.test(toml)) {
  fail(`${tomlPath} has no [vars] section to write WAKER_MODE into.`);
}

toml = toml
  .replace(/^WAKER_MODE\s*=.*\n/gm, '')
  .replace(/^WAKER_URL\s*=.*\n/gm, '');

const managed = [`WAKER_MODE = "${mode}"`];
if (mode === 'waker') managed.push(`WAKER_URL = "${url}"`);
toml = toml.replace(/^\[vars\]\s*$/m, `[vars]\n${managed.join('\n')}`);

writeFileSync(tomlPath, toml);

// ─── Report ──────────────────────────────────────────────────────────────────

const outputs = [`mode=${mode}`, `triggers=${triggers}`];
if (mode === 'waker') outputs.push(`url=${url}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
}

if (mode === 'waker') {
  console.log(
    `waker mode: WAKER_MODE=waker WAKER_URL=${url} WAKER_TRIGGERS=${triggers}` +
      (triggers === 'keep'
        ? ' — dual run: the native Cron Trigger still fires, the receiver is open'
        : ' — native [triggers] removed, the platform is the only scheduler'),
  );
} else {
  console.log(
    `waker mode: WAKER_MODE=cron WAKER_TRIGGERS=${triggers} — native Cron Trigger, waker callback closed`,
  );
}
