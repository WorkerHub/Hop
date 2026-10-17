#!/usr/bin/env bash
# Public-hostname probes. A 403 with Cloudflare's documented challenge header is
# inconclusive (warning), not an application failure. The separate control-plane
# deployment check must succeed even if every HTTP probe is challenged.
set -euo pipefail

if [[ -z "${APP_URL:-}" ]]; then
  echo "::error::Variable APP_URL is not set; cannot verify the deployment"
  exit 1
fi
base="${APP_URL%/}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

probe() { # probe <path> [jq filter the JSON body must satisfy]
  local path="$1" filter="${2:-}" code attempt
  for attempt in 1 2 3 4 5 6; do
    # One request per attempt keeps the headers/body/status together: curl's
    # built-in retries can leave earlier responses in the headers file.
    if ! code="$(curl -sS --connect-timeout 10 --max-time 15 \
      -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}' "$base$path")"; then
      code=000
    fi
    if [[ "$code" == 2?? ]]; then
      if [[ -n "$filter" ]] && ! jq -e "$filter" "$tmp/body" >/dev/null; then
        echo "::error::GET $path -> $code, but the response failed the check: $filter"
        return 1
      fi
      echo "GET $path -> $code"
      return 0
    fi
    if [[ "$code" == 403 ]] && grep -qiE '^cf-mitigated:[[:blank:]]*challenge[[:space:]]*$' "$tmp/headers"; then
      echo "::warning::GET $path -> 403 Cloudflare challenge (cf-mitigated: challenge). HTTP check inconclusive; relying on the API-side deployment check. Keep Bot Fight Mode enabled."
      return 0
    fi
    if [[ $attempt -lt 6 ]]; then
      sleep 5
    fi
  done
  echo "::error::GET $path -> HTTP $code (000 means transport failure)"
  return 1
}

probe /api/health '.status == "ok"'
probe /
# This reads the settings table for both migration paths, including TABLE_PREFIX.
# A challenge still means inconclusive, NOT that the DB check passed.
if [[ "${CHECK_DB:-false}" == true ]]; then
  probe /api/config 'has("appName")'
fi
