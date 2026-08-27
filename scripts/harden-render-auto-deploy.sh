#!/usr/bin/env bash

set -euo pipefail

: "${RENDER_API_KEY:?RENDER_API_KEY is required}"

command -v curl >/dev/null
command -v jq >/dev/null

api_base="https://api.render.com/v1"
readonly -a expected_services=(
  axel-clickhouse
  axel-delivery-native
  axel-delivery-workers
  axel-pull-worker
)
readonly -a curl_args=(
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

services="$(curl "${curl_args[@]}" "${api_base}/services?limit=100")"

for service_name in "${expected_services[@]}"; do
  matches="$({
    jq -c \
      --arg name "$service_name" \
      '[.[] | (.service // .) | select(.name == $name)]' \
      <<<"$services"
  })"
  match_count="$(jq 'length' <<<"$matches")"
  if [[ "$match_count" != "1" ]]; then
    echo "expected exactly one Render service named ${service_name}; found ${match_count}" >&2
    exit 1
  fi

  service_id="$(jq -r '.[0].id // empty' <<<"$matches")"
  if [[ ! "$service_id" =~ ^srv-[A-Za-z0-9_-]+$ ]]; then
    echo "Render returned an invalid service id for ${service_name}" >&2
    exit 1
  fi

  # Render's service update API uses autoDeploy="no". Apply it on every
  # reviewed rollout instead of trusting stale Blueprint or dashboard state.
  curl "${curl_args[@]}" \
    -H 'Content-Type: application/json' \
    -X PATCH \
    --data-binary '{"autoDeploy":"no"}' \
    "${api_base}/services/${service_id}" \
    >/dev/null

  readback="$(curl "${curl_args[@]}" "${api_base}/services/${service_id}")"
  configured="$({
    jq -r '(.service // .).autoDeploy // empty' <<<"$readback"
  })"
  if [[ "$configured" != "no" ]]; then
    echo "Render auto-deploy readback failed for ${service_name}" >&2
    exit 1
  fi

  echo "Render git auto-deploy disabled: ${service_name}"
done
