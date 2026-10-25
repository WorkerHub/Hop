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
# 'sl'; compare literally (case-sensitive) so e.g. production `SL` is never
# folded into `sl` and reported as a false match.
expected="${TABLE_PREFIX:-}"
if [[ "$live" != "$expected" ]]; then
  echo "::error::Deployed version uses TABLE_PREFIX='$live', but migrations were applied for '${expected:-<none>}'."
  exit 1
fi
echo "TABLE_PREFIX: ${live:-<none>}"
