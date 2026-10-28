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
#      WORKER_NAME               — optional, Worker name for the version lookup
#                                  (default 'hop', the name in wrangler.toml)
#      WAKER_MODE / WAKER_TRIGGERS — resolved deploy mode; waker+remove must leave
#                                  no cron schedule, every other mode exactly one
#                                  `0 3 * * *` schedule. CLOUDFLARE_API_TOKEN is
#                                  needed for the schedules lookup.
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
# WAKER_SIGNING_KEY is required exactly when this deploy ran in waker mode: a
# callback version without it answers 500 signing_key_missing to every
# execution, which only shows up at 03:00. Cron-mode deploys do not inject it.
required_secrets="JWT_SECRET SETUP_SECRET TOTP_ENCRYPTION_KEY"
if [[ "${WAKER_MODE:-cron}" == "waker" ]]; then
  required_secrets="${required_secrets} WAKER_SIGNING_KEY"
  echo "Waker mode: callback receiver enabled; WAKER_SIGNING_KEY must be bound"
fi
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

# Cron schedules gate. `wrangler deploy` syncs cron schedules from the config, so
# this is what actually proves the mode's promise: no schedule at all in waker
# mode with WAKER_TRIGGERS=remove, exactly `0 3 * * *` otherwise (native cron, or
# the dual-run transition). The deploy log never shows schedules, so without
# this gate only a human looking at the dashboard would notice a missed switch.
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
if [[ "${WAKER_MODE:-cron}" == "waker" && "${WAKER_TRIGGERS:-keep}" == "remove" ]]; then
  if [[ -n "$crons" ]]; then
    echo "::error::Worker ${worker_name} still has cron schedule(s) '${crons}', but WAKER_MODE=waker + WAKER_TRIGGERS=remove promises none. Re-run the deploy after the [triggers] removal, or delete the schedule in the dashboard."
    exit 1
  fi
  echo "Cron schedules: none (waker is the only scheduler)"
else
  if [[ "$crons" != "0 3 * * *" ]]; then
    echo "::error::Worker ${worker_name} has cron schedule(s) '${crons:-<none>}', expected exactly '0 3 * * *' (WAKER_MODE=${WAKER_MODE:-cron}, WAKER_TRIGGERS=${WAKER_TRIGGERS:-keep}). The native Cron Trigger must stay in this mode."
    exit 1
  fi
  echo "Cron schedules: 0 3 * * *"
fi
