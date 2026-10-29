#!/usr/bin/env bash
# Confirms through the Cloudflare API that the version uploaded by
# `wrangler deploy` is serving 100% of production traffic, with the
# TABLE_PREFIX the migrations were applied for. Unlike an HTTP probe of the
# public hostname this can't be intercepted by the zone's bot protection (Bot
# Fight Mode challenges GitHub-hosted runners and cannot be bypassed).
# Run from apps/worker (needs wrangler.toml with real IDs injected).
#
# Env: WRANGLER_OUTPUT_FILE_PATH — the ND-JSON file `wrangler deploy` wrote
#      TABLE_PREFIX              — resolved prefix ('' means explicit no prefix)
#      WAKER_SIGNING_KEY_EXPECTED — 'bound' when the repository Secret existed and
#                                  was injected into the secrets file, 'absent'
#                                  otherwise. Required: 'bound' asserts the key is
#                                  really bound on the uploaded version (a callback
#                                  without it only fails at 03:00 with 500
#                                  signing_key_missing); 'absent' just records that
#                                  the receiver fails closed. No mode variable.
#                                  Waker is the only scheduler now, so 'absent' also
#                                  warns that no cleanup runs at all.
#      WORKER_NAME               — optional, Worker name for the version lookup
#                                  (default 'hop', the name in wrangler.toml)
#      CLOUDFLARE_API_TOKEN      — needed for the schedules lookup.
#
# The last gate asserts the Worker carries no native Cron Trigger at all: since
# the switch, waker delivers the nightly cleanup over HTTP and the native
# schedule must be gone (wrangler.toml declares `crons = []`).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="${WRANGLER_OUTPUT_FILE_PATH:?WRANGLER_OUTPUT_FILE_PATH is not set}"

version=""
if [[ -f "$output" ]]; then
  version="$(jq -rs '[.[] | select(.type == "deploy")] | last | .version_id // empty' "$output")"
fi
if [[ -z "$version" ]]; then
  echo "::error::No deployed version ID found in $output; cannot verify the deployment."
  exit 1
fi
echo "Uploaded version: $version"

# Secrets gate: the deploy uploads JWT_SECRET / SETUP_SECRET / TOTP_ENCRYPTION_KEY
# from the file passed to `--secrets-file`. That flag used to be dropped by pnpm's
# argument forwarding, so a green deploy could still ship a version with no
# secrets bound and only fail at runtime (POST /api/setup → 500). Assert the
# bindings on the uploaded version itself. `versions view --json` returns binding
# names and types only — never secret values — so this output is safe in CI logs.
# `--secrets-file` is additive (omitted secrets are not deleted), so a re-run
# backfills anything reported missing here.
worker_name="${WORKER_NAME:-hop}"
secrets_view="$(pnpm exec wrangler versions view "$version" --name "$worker_name" --json)"
# Don't turn an unexpected API response into a silent pass.
jq -e --arg v "$version" '.id == $v and (.resources.bindings | type == "array")' <<<"$secrets_view" >/dev/null
# WAKER_SIGNING_KEY is the only switch of the callback and is mode-free: when the
# repository Secret exists the secrets file carries it, so the uploaded version
# must have the binding; otherwise the callback fails closed (500
# signing_key_missing) and nothing is required. There is no mode any more, so the
# rest of the required list is static.
required_secrets="JWT_SECRET SETUP_SECRET TOTP_ENCRYPTION_KEY"
case "${WAKER_SIGNING_KEY_EXPECTED:-}" in
  bound)
    required_secrets="${required_secrets} WAKER_SIGNING_KEY"
    echo "Waker callback: WAKER_SIGNING_KEY configured — it must be bound on the version"
    ;;
  absent)
    echo "Waker callback: no WAKER_SIGNING_KEY configured — /_waker/execute fails closed (500 signing_key_missing)"
    echo "::warning::Waker is the only scheduler and no WAKER_SIGNING_KEY is configured: the nightly cleanup will NOT run at all until the GitHub Secret exists and a deployment injects it."
    ;;
  *)
    echo "::error::WAKER_SIGNING_KEY_EXPECTED must be 'bound' or 'absent' (got '${WAKER_SIGNING_KEY_EXPECTED:-<unset>}'); cannot verify the waker callback state."
    exit 1
    ;;
esac
missing_secrets="$(jq -r --arg names "$required_secrets" '
  ([.resources.bindings[] | select(.type == "secret_text") | .name]) as $bound
  | ($names | split(" "))
  | map(select(. as $name | ($bound | index($name)) == null))
  | join(", ")' <<<"$secrets_view")"
if [[ -n "$missing_secrets" ]]; then
  echo "::error::Worker version $version has no secret_text binding for: ${missing_secrets}. The deploy did not apply --secrets-file; re-run the Deploy workflow to re-upload the version with the secrets file."
  exit 1
fi
echo "Secret bindings on version $version: $required_secrets"

status=""
for attempt in 1 2 3 4 5; do
  if status="$(pnpm exec wrangler deployments status --json)" &&
    jq -e --arg v "$version" \
      '.versions | length == 1 and .[0].version_id == $v and .[0].percentage == 100' \
      <<<"$status" >/dev/null; then
    echo "Version $version serves 100% of production traffic."
    break
  fi
  if [[ $attempt -eq 5 ]]; then
    echo "::error::Version $version is not the active deployment. Current versions: $(jq -c '.versions' <<<"${status:-null}" 2>/dev/null || echo unknown)"
    exit 1
  fi
  sleep 5
done

live="$(bash "$here/worker-table-prefix.sh" "$version")"
live="${live//[^A-Za-z0-9_]/}"
# worker-table-prefix.sh already maps an unset Worker binding to the default
# 'hop'; compare literally (case-sensitive) so e.g. production `SL` is never
# folded into `sl` and reported as a false match.
expected="${TABLE_PREFIX:-}"
if [[ "$live" != "$expected" ]]; then
  echo "::error::Deployed version uses TABLE_PREFIX='$live', but migrations were applied for '${expected:-<none>}'."
  exit 1
fi
echo "TABLE_PREFIX: ${live:-<none>}"

# Cron schedules gate: none may remain. `wrangler deploy` replaces the deployed
# schedules with those in the config, and `[triggers] crons = []` in wrangler.toml
# therefore removes the native Cron Trigger on every deploy (an absent section
# would leave the already-deployed schedule in place). Waker is the only
# scheduler, so a leftover schedule means the switch did not take effect and the
# Worker would keep running a second, unmanaged nightly cleanup.
account_id="$(sed -n 's/^account_id[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' wrangler.toml | head -n 1)"
if [[ -z "$account_id" ]]; then
  echo "::error::Cannot read account_id from wrangler.toml; cannot verify cron schedules."
  exit 1
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "::error::CLOUDFLARE_API_TOKEN is not set; cannot verify cron schedules."
  exit 1
fi
schedules="$(curl -sS --max-time 20 \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${account_id}/workers/scripts/${worker_name}/schedules" || true)"
if ! jq -e '.success == true and (.result.schedules | type == "array")' \
  <<<"${schedules:-null}" >/dev/null 2>&1; then
  echo "::error::Cloudflare API GET /workers/scripts/${worker_name}/schedules failed or returned an unexpected body ($(jq -c '.errors // empty' <<<"${schedules:-null}" 2>/dev/null || echo unknown)); cannot verify cron schedules."
  exit 1
fi
crons="$(jq -r '[.result.schedules[].cron] | sort | join(" ")' <<<"$schedules")"
if [[ -n "$crons" ]]; then
  echo "::error::Worker ${worker_name} still has cron schedule(s) '${crons}', expected no cron schedules. Waker is the only scheduler now and wrangler.toml declares [triggers] crons = [] so every deploy removes the native Cron Trigger. Remove the leftover schedule (dashboard → Triggers → delete the Cron Trigger, or PUT /accounts/${account_id}/workers/scripts/${worker_name}/schedules with an empty array) and re-run the deploy."
  exit 1
fi
echo "Cron schedules: <none>"
