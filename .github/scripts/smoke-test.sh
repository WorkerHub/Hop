#!/usr/bin/env bash
# Public-hostname probes. A 403 with Cloudflare's documented challenge header is
# inconclusive (warning), not an application failure. The separate control-plane
# deployment check must succeed even if every HTTP probe is challenged.
#
# Target URL: `vars.APP_URL` when it is set — a custom domain is the real
# production entry point, so it is probed whenever it is configured. When it is
# not set, the Worker's workers.dev address is resolved instead. That address
# cannot be built from ACCOUNT_ID (the workers.dev subdomain is an account-level
# string), but it can be read from the Cloudflare API:
#
#   https://<worker name>.<account workers.dev subdomain>.workers.dev
#
# Env: APP_URL               — public entry point (optional)
#      CLOUDFLARE_API_TOKEN  — only needed when APP_URL is empty
#      ACCOUNT_ID            — only needed when APP_URL is empty
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
api="https://api.cloudflare.com/client/v4"

cf_get() { # cf_get <api path> — prints the response body
  curl -sS --max-time 20 \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "$api$1"
}

api_error() { # api_error <response> — compact error list for messages
  local detail
  detail="$(jq -c 'if type == "object" then (.errors // empty) else empty end' \
    <<<"${1:-null}" 2>/dev/null || true)"
  printf '%s' "${detail:-unknown error}"
}

worker_name() {
  local name=""
  if [[ -f "$repo/apps/worker/wrangler.toml" ]]; then
    name="$(sed -n 's/^name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
      "$repo/apps/worker/wrangler.toml" | head -n 1)"
  fi
  if [[ -z "$name" ]]; then
    echo "::error::Cannot read the Worker name from $repo/apps/worker/wrangler.toml" >&2
    return 1
  fi
  printf '%s' "$name"
}

resolve_workers_dev() { # prints the workers.dev URL of this Worker
  local worker flags resp subdomain
  worker="$(worker_name)" || return 1

  # Whether the script is served on workers.dev at all. A disabled route
  # resolves to a host that never answers, so say that plainly instead of
  # letting it look like the application is broken.
  flags="$(cf_get "/accounts/${ACCOUNT_ID}/workers/scripts/${worker}/subdomain" || true)"
  if jq -e '.success == true' <<<"${flags:-null}" >/dev/null 2>&1; then
    if [[ "$(jq -r '.result.enabled' <<<"$flags")" != "true" ]]; then
      echo "::error::workers.dev is not enabled for Worker '${worker}' — the account or the script disabled its workers.dev route. That is a routing configuration problem, not an application failure. Set vars.APP_URL to a bound custom domain to smoke test it." >&2
      return 1
    fi
  else
    echo "::warning::Could not read whether Worker '${worker}' is served on workers.dev ($(api_error "$flags")); trying the workers.dev address anyway." >&2
  fi

  resp="$(cf_get "/accounts/${ACCOUNT_ID}/workers/subdomain" || true)"
  if ! jq -e '.success == true' <<<"${resp:-null}" >/dev/null 2>&1; then
    echo "::error::Cloudflare API GET /accounts/${ACCOUNT_ID}/workers/subdomain failed, so the workers.dev address cannot be resolved ($(api_error "$resp")). CLOUDFLARE_API_TOKEN needs Workers Scripts:Read; alternatively set vars.APP_URL to a bound custom domain." >&2
    return 1
  fi
  subdomain="$(jq -r '.result.subdomain // empty' <<<"$resp")"
  if [[ -z "$subdomain" ]]; then
    echo "::error::The Cloudflare API returned no workers.dev subdomain for this account; set vars.APP_URL to a bound custom domain instead." >&2
    return 1
  fi
  printf 'https://%s.%s.workers.dev' "$worker" "$subdomain"
}

derived=false
if [[ -n "${APP_URL:-}" ]]; then
  base="${APP_URL%/}"
elif [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${ACCOUNT_ID:-}" ]]; then
  echo "::error::Neither vars.APP_URL nor CLOUDFLARE_API_TOKEN+ACCOUNT_ID are set; cannot work out which URL to smoke test. Set vars.APP_URL, or keep the credentials the deploy workflow passes so the workers.dev address can be resolved automatically." >&2
  exit 1
else
  base="$(resolve_workers_dev)" || exit 1
  derived=true
  echo "Resolved workers.dev address: $base"
fi
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
  if [[ "$derived" == "true" ]]; then
    echo "::warning::The target was resolved from this account's workers.dev subdomain. If the account or Worker has workers.dev disabled, that is a routing configuration problem, not an application failure — set vars.APP_URL to a bound custom domain."
  fi
  return 1
}

probe /api/health '.status == "ok"'
probe /
# This reads the settings table for both migration paths, including TABLE_PREFIX.
# A challenge still means inconclusive, NOT that the DB check passed.
if [[ "${CHECK_DB:-false}" == true ]]; then
  probe /api/config 'has("appName")'
fi
