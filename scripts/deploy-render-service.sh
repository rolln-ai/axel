#!/usr/bin/env bash

set -euo pipefail

render_service="${1:-}"
commit_sha="${2:-}"

if [[ -z "$render_service" || -z "$commit_sha" ]]; then
  echo "usage: $0 <render-service-name> <full-git-sha>" >&2
  exit 2
fi

: "${RENDER_API_KEY:?RENDER_API_KEY is required}"

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
discovery_interval_seconds="${RENDER_DEPLOY_DISCOVERY_INTERVAL_SECONDS:-6}"
poll_interval_seconds="${RENDER_DEPLOY_POLL_INTERVAL_SECONDS:-15}"
timeout_seconds="${RENDER_DEPLOY_TIMEOUT_SECONDS:-2400}"

if [[ ! "$discovery_interval_seconds" =~ ^[0-9]+$ ]] \
  || [[ ! "$poll_interval_seconds" =~ ^[0-9]+$ ]] \
  || [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "Render deploy polling intervals must be non-negative integers and timeout must be positive" >&2
  exit 2
fi

readonly -a curl_read_args=(
  --fail-with-body
  --silent
  --show-error
  --connect-timeout 10
  --max-time 45
  --retry 5
  --retry-all-errors
  --retry-delay 3
  -H "Authorization: Bearer ${RENDER_API_KEY}"
)

services="$(curl "${curl_read_args[@]}" "${api_base}/services?limit=100")"
matches="$(
  jq -c \
    --arg name "$render_service" \
    '[.[] | (.service // .) | select(.name == $name)]' \
    <<<"$services"
)"
match_count="$(jq 'length' <<<"$matches")"
if [[ "$match_count" != "1" ]]; then
  echo "expected exactly one Render service named ${render_service}; found ${match_count}" >&2
  exit 1
fi

service_id="$(jq -r '.[0].id' <<<"$matches")"
deploys_url="${api_base}/services/${service_id}/deploys"

# A rerun should wait for an existing in-progress deploy of this SHA, and it
# should treat an already-live deploy as success instead of starting another.
deploys="$(curl "${curl_read_args[@]}" "${deploys_url}?limit=100")"
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

if [[ "$deploy_status" == "live" ]]; then
  echo "Render service ${render_service} is already live at ${commit_sha} (${deploy_id})"
  exit 0
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
        echo "Render deploy request failed with HTTP ${http_status}: ${response}" >&2
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
        deploys="$(curl "${curl_read_args[@]}" "${deploys_url}?limit=100")"
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
    echo "Started Render deploy ${deploy_id} for ${render_service} at ${commit_sha}"
    ;;
  *)
    echo "Reusing Render deploy ${deploy_id} for ${render_service} (${deploy_status})"
    ;;
esac

deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  deploy="$(curl "${curl_read_args[@]}" "${deploys_url}/${deploy_id}")"
  deploy_status="$(jq -r '(.deploy // .).status // empty' <<<"$deploy")"

  case "$deploy_status" in
    live)
      echo "Render deploy ${deploy_id} is live for ${render_service} at ${commit_sha}"
      exit 0
      ;;
    build_failed|update_failed|pre_deploy_failed|canceled|cancelled|deactivated)
      echo "Render deploy ${deploy_id} failed with status ${deploy_status}" >&2
      exit 1
      ;;
    "")
      echo "Render deploy ${deploy_id} returned no status" >&2
      exit 1
      ;;
    *)
      echo "Render deploy ${deploy_id}: ${deploy_status}"
      ;;
  esac

  sleep "$poll_interval_seconds"
done

echo "timed out waiting for Render deploy ${deploy_id} (${render_service})" >&2
exit 1
