#!/usr/bin/env bash

set -euo pipefail

if (( $# > 1 )); then
  echo "usage: $0 [render-service-name]" >&2
  exit 2
fi

declare -a expected_service_specs
declare -a expected_services
if (( $# == 0 )); then
  expected_service_specs=(
    axel-delivery-native:web_service
    axel-delivery-workers:background_worker:1
    axel-pull-worker:background_worker
  )
  expected_services=(
    axel-delivery-native
    axel-delivery-workers
    axel-pull-worker
  )
else
  target_service="$1"
  case "$target_service" in
    axel-delivery-native)
      expected_service_specs=(axel-delivery-native:web_service)
      expected_services=(axel-delivery-native)
      ;;
    axel-delivery-workers)
      expected_service_specs=(axel-delivery-workers:background_worker:1)
      expected_services=(axel-delivery-workers)
      ;;
    axel-pull-worker)
      expected_service_specs=(axel-pull-worker:background_worker)
      expected_services=(axel-pull-worker)
      ;;
    *)
      echo "unsupported Render service" >&2
      exit 2
      ;;
  esac
fi
readonly expected_service_specs expected_services

: "${RENDER_API_KEY:?RENDER_API_KEY is required}"
: "${RENDER_OWNER_ID:?RENDER_OWNER_ID is required}"

command -v curl >/dev/null
command -v jq >/dev/null

api_base="https://api.render.com/v1"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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

# Resolve every selected service before the first PATCH. This prevents a
# duplicate or malformed target on a later page from causing a partial update.
# shellcheck source=scripts/render-service-discovery.sh
source "${script_dir}/render-service-discovery.sh"
resolved_services="$(
  render_resolve_services \
    "$api_base" \
    "$RENDER_OWNER_ID" \
    "${expected_service_specs[@]}"
)"

for service_name in "${expected_services[@]}"; do
  service_id="$(jq -r --arg name "$service_name" '.[] | select(.name == $name) | .id' <<<"$resolved_services")"

  # Render's service update API uses autoDeploy="no". Apply it on every
  # reviewed rollout instead of trusting stale Blueprint or dashboard state.
  curl "${render_curl_read_args[@]}" \
    -H 'Content-Type: application/json' \
    -X PATCH \
    --data-binary '{"autoDeploy":"no"}' \
    "${api_base}/services/${service_id}" \
    >/dev/null

  readback="$(curl "${render_curl_read_args[@]}" "${api_base}/services/${service_id}")"
  configured="$({
    jq -r '(.service // .).autoDeploy // empty' <<<"$readback"
  })"
  if [[ "$configured" != "no" ]]; then
    echo "Render auto-deploy readback failed for ${service_name}" >&2
    exit 1
  fi

  echo "Render git auto-deploy disabled: ${service_name}"
done
