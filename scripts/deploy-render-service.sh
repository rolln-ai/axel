#!/usr/bin/env bash

set -euo pipefail

render_service="${1:-}"
commit_sha="${2:-}"
mode="${3:-}"

if [[ -z "$render_service" || -z "$commit_sha" || ( -n "$mode" && "$mode" != "--force-redeploy" ) ]]; then
  echo "usage: $0 <render-service-name> <full-git-sha> [--force-redeploy]" >&2
  exit 2
fi
force_redeploy=0
if [[ "$mode" == "--force-redeploy" ]]; then
  force_redeploy=1
fi

: "${RENDER_API_KEY:?RENDER_API_KEY is required}"
: "${RENDER_OWNER_ID:?RENDER_OWNER_ID is required}"

if [[ ! "$render_service" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid Render service name" >&2
  exit 2
fi
if [[ ! "$commit_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "commit SHA must contain 40 hexadecimal characters" >&2
  exit 2
fi

command -v curl >/dev/null
command -v jq >/dev/null

api_base="https://api.render.com/v1"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
discovery_interval_seconds="${RENDER_DEPLOY_DISCOVERY_INTERVAL_SECONDS:-6}"
poll_interval_seconds="${RENDER_DEPLOY_POLL_INTERVAL_SECONDS:-15}"
timeout_seconds="${RENDER_DEPLOY_TIMEOUT_SECONDS:-2400}"

if [[ ! "$discovery_interval_seconds" =~ ^[0-9]+$ ]] \
  || [[ ! "$poll_interval_seconds" =~ ^[0-9]+$ ]] \
  || [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "Render deploy polling intervals must be non-negative integers and timeout must be positive" >&2
  exit 2
fi

readonly -a render_curl_read_args=(
  --fail-with-body
  --silent
  --show-error
  --connect-timeout 10
  --max-time 45
  --max-filesize 2097152
  --retry 5
  --retry-all-errors
  --retry-delay 3
  -H "Authorization: Bearer ${RENDER_API_KEY}"
)

# shellcheck source=scripts/render-service-discovery.sh
source "${script_dir}/render-service-discovery.sh"
case "$render_service" in
  axel-delivery-native) expected_service_type=web_service ;;
  axel-delivery-workers) expected_service_type=background_worker ;;
  axel-pull-worker) expected_service_type=background_worker ;;
  *)
    echo "unsupported Render service" >&2
    exit 2
    ;;
esac
service_spec="${render_service}:${expected_service_type}"
if [[ "$render_service" == "axel-delivery-workers" ]]; then
  service_spec="${service_spec}:1"
fi
resolved_services="$(
  render_resolve_services "$api_base" "$RENDER_OWNER_ID" "$service_spec"
)"

service_id="$(jq -r '.[0].id' <<<"$resolved_services")"
deploys_url="${api_base}/services/${service_id}/deploys"

# A rerun should wait for an existing in-progress deploy of this SHA, and it
# should treat an already-live deploy as success instead of starting another.
deploys="$(curl "${render_curl_read_args[@]}" "${deploys_url}?limit=100")"
matching_deploy="$(
  jq -c \
    --arg commit "$commit_sha" \
    '[
      .[]
      | (.deploy // .)
      | select((.commit.id // .commitId // "") == $commit)
    ]
    | sort_by(.createdAt)
    | reverse
    | .[0] // empty' \
    <<<"$deploys"
)"
existing_deploy_ids="$(
  jq -c \
    --arg commit "$commit_sha" \
    '[
      .[]
      | (.deploy // .)
      | select((.commit.id // .commitId // "") == $commit)
      | .id
    ]' \
    <<<"$deploys"
)"

if [[ -n "$matching_deploy" ]]; then
  deploy_id="$(jq -r '.id // empty' <<<"$matching_deploy")"
  deploy_status="$(jq -r '.status // empty' <<<"$matching_deploy")"
else
  deploy_id=""
  deploy_status=""
fi

if [[ "$deploy_status" == "live" && "$force_redeploy" == "0" ]]; then
  echo "Render service ${render_service} is already live at ${commit_sha}"
  exit 0
fi
if [[ "$deploy_status" == "live" ]]; then
  deploy_id=""
  deploy_status=""
fi

case "$deploy_status" in
  ""|build_failed|update_failed|pre_deploy_failed|canceled|cancelled|deactivated)
    payload="$(
      jq -n \
        --arg commit_id "$commit_sha" \
        '{ clearCache: "do_not_clear", commitId: $commit_id }'
    )"
    response_with_status="$(
      curl \
        --silent \
        --show-error \
        --connect-timeout 10 \
        --max-time 45 \
        --write-out $'\n%{http_code}' \
        -H "Authorization: Bearer ${RENDER_API_KEY}" \
        -H 'Content-Type: application/json' \
        -X POST \
        --data-binary "$payload" \
        "$deploys_url"
    )"
    http_status="${response_with_status##*$'\n'}"
    response="${response_with_status%$'\n'*}"
    case "$http_status" in
      201|202)
        ;;
      409)
        # Another actor may have started the same deploy after our initial
        # idempotency check. The lookup below reuses it when the SHA matches.
        response=""
        ;;
      *)
        echo "Render deploy request failed with HTTP ${http_status}" >&2
        exit 1
        ;;
    esac
    if [[ -n "$response" ]]; then
      deploy_id="$(jq -r '(.deploy // .).id // empty' <<<"$response")"
    else
      deploy_id=""
    fi

    # Render can return 202 with an empty body while a deploy is queued. Wait
    # for that exact-SHA deploy to become visible instead of starting another.
    if [[ -z "$deploy_id" ]]; then
      for _ in {1..20}; do
        sleep "$discovery_interval_seconds"
        deploys="$(curl "${render_curl_read_args[@]}" "${deploys_url}?limit=100")"
        deploy_id="$(
          jq -r \
            --arg commit "$commit_sha" \
            --argjson existing_ids "$existing_deploy_ids" \
            '[
              .[]
              | (.deploy // .)
              | select(
                  (.commit.id // .commitId // "") == $commit
                  and (.id as $id | $existing_ids | index($id) | not)
                )
            ]
            | sort_by(.createdAt)
            | reverse
            | .[0].id // empty' \
            <<<"$deploys"
        )"
        [[ -z "$deploy_id" ]] || break
      done
    fi
    if [[ -z "$deploy_id" ]]; then
      echo "Render accepted the deploy but no deploy id became visible for ${render_service}" >&2
      exit 1
    fi
    echo "Started Render deploy for ${render_service} at ${commit_sha}"
    ;;
  *)
    echo "Reusing Render deploy for ${render_service} (${deploy_status})"
    ;;
esac

deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  deploy="$(curl "${render_curl_read_args[@]}" "${deploys_url}/${deploy_id}")"
  deploy_status="$(jq -r '(.deploy // .).status // empty' <<<"$deploy")"
  deploy_commit="$(jq -r '(.deploy // .) | (.commit.id // .commitId // empty)' <<<"$deploy")"

  if [[ -n "$deploy_commit" && "$deploy_commit" != "$commit_sha" ]]; then
    echo "Render deploy commit readback did not match the requested commit" >&2
    exit 1
  fi

  case "$deploy_status" in
    live)
      if [[ "$deploy_commit" != "$commit_sha" ]]; then
        echo "Render live deploy did not include the requested commit" >&2
        exit 1
      fi
      echo "Render deploy is live for ${render_service} at ${commit_sha}"
      exit 0
      ;;
    build_failed|update_failed|pre_deploy_failed|canceled|cancelled|deactivated)
      echo "Render deploy for ${render_service} failed with status ${deploy_status}" >&2
      exit 1
      ;;
    "")
      echo "Render deploy for ${render_service} returned no status" >&2
      exit 1
      ;;
    *)
      echo "Render deploy for ${render_service}: ${deploy_status}"
      ;;
  esac

  sleep "$poll_interval_seconds"
done

echo "timed out waiting for Render deploy (${render_service})" >&2
exit 1
