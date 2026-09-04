#!/usr/bin/env bash

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "skipping $(basename "$0"): jq is not installed" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

export PATH="${repo_root}/scripts/test/fixtures/render-bin:${PATH}"
export RENDER_API_KEY=test-key
export RENDER_OWNER_ID=tea-test-owner
export RENDER_DEPLOY_DISCOVERY_INTERVAL_SECONDS=0
export RENDER_DEPLOY_POLL_INTERVAL_SECONDS=0
export RENDER_DEPLOY_TIMEOUT_SECONDS=5
export MOCK_RENDER_COMMIT=0123456789abcdef0123456789abcdef01234567

run_dir="${test_root}/clickhouse-rejected"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=success

if output="$(
  bash "${repo_root}/scripts/deploy-render-service.sh" \
    axel-clickhouse \
    "$MOCK_RENDER_COMMIT" 2>&1
)"; then
  echo "ClickHouse unexpectedly remained deployable through release automation" >&2
  exit 1
fi
[[ ! -e "${run_dir}/calls.tsv" ]]
[[ "$output" != *"$RENDER_API_KEY"* ]]

run_dir="${test_root}/success"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=success

bash "${repo_root}/scripts/deploy-render-service.sh" \
  axel-delivery-native \
  "$MOCK_RENDER_COMMIT"

jq -e \
  --arg commit "$MOCK_RENDER_COMMIT" \
  '.clearCache == "do_not_clear" and .commitId == $commit' \
  "${run_dir}/deploy-request.json" \
  >/dev/null
[[ "$(<"${run_dir}/poll-count")" == "2" ]]

run_dir="${test_root}/wrong-commit-poll"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=wrong-commit-poll

if output="$(
  bash "${repo_root}/scripts/deploy-render-service.sh" \
    axel-delivery-native \
    "$MOCK_RENDER_COMMIT" 2>&1
)"; then
  echo "a live Render deploy at the wrong commit unexpectedly passed" >&2
  exit 1
fi
[[ "$output" == *"commit readback did not match"* ]]
[[ "$output" != *"$RENDER_API_KEY"* ]]

run_dir="${test_root}/deep-page"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=deep-page-deploy

bash "${repo_root}/scripts/deploy-render-service.sh" \
  axel-delivery-native \
  "$MOCK_RENDER_COMMIT"

service_list_count="$(awk -F '\t' '$1 == "GET" && index($2, "/v1/services?ownerId=tea-test-owner&includePreviews=false&limit=100") > 0 { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
post_count="$(awk -F '\t' '$1 == "POST" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$service_list_count" == "2" ]]
[[ "$post_count" == "1" ]]
grep -F $'GET\thttps://api.render.com/v1/services?ownerId=tea-test-owner&includePreviews=false&limit=100&cursor=cursor%2Bdeep%2Fdeploy%3D' \
  "${run_dir}/calls.tsv" \
  >/dev/null

run_dir="${test_root}/existing-live"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=existing-live

bash "${repo_root}/scripts/deploy-render-service.sh" \
  axel-delivery-native \
  "$MOCK_RENDER_COMMIT"

post_count="$(awk -F '\t' '$1 == "POST" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$post_count" == "0" ]]

run_dir="${test_root}/existing-live-force"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=existing-live

bash "${repo_root}/scripts/deploy-render-service.sh" \
  axel-delivery-native \
  "$MOCK_RENDER_COMMIT" \
  --force-redeploy

post_count="$(awk -F '\t' '$1 == "POST" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$post_count" == "1" ]]
jq -e \
  --arg commit "$MOCK_RENDER_COMMIT" \
  '.clearCache == "do_not_clear" and .commitId == $commit' \
  "${run_dir}/deploy-request.json" \
  >/dev/null

run_dir="${test_root}/duplicate-later"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=duplicate-later-deploy

if output="$(
  bash "${repo_root}/scripts/deploy-render-service.sh" \
    axel-delivery-native \
    "$MOCK_RENDER_COMMIT" 2>&1
)"; then
  echo "duplicate Render service on a later page unexpectedly triggered a deploy" >&2
  exit 1
fi
post_count="$(awk -F '\t' '$1 == "POST" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$post_count" == "0" ]]
[[ "$output" != *"$RENDER_API_KEY"* ]]

run_dir="${test_root}/pagination-cycle"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=pagination-cycle

if output="$(
  bash "${repo_root}/scripts/deploy-render-service.sh" \
    axel-delivery-native \
    "$MOCK_RENDER_COMMIT" 2>&1
)"; then
  echo "repeated Render pagination cursor unexpectedly triggered a deploy" >&2
  exit 1
fi
service_list_count="$(awk -F '\t' '$1 == "GET" && index($2, "/v1/services?ownerId=tea-test-owner&includePreviews=false&limit=100") > 0 { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
post_count="$(awk -F '\t' '$1 == "POST" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$service_list_count" == "2" ]]
[[ "$post_count" == "0" ]]
[[ "$output" != *"$RENDER_API_KEY"* ]]

run_dir="${test_root}/pagination-bound"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=pagination-bound

if output="$(
  bash "${repo_root}/scripts/deploy-render-service.sh" \
    axel-delivery-native \
    "$MOCK_RENDER_COMMIT" 2>&1
)"; then
  echo "Render pagination beyond the page bound unexpectedly triggered a deploy" >&2
  exit 1
fi
service_list_count="$(awk -F '\t' '$1 == "GET" && index($2, "/v1/services?ownerId=tea-test-owner&includePreviews=false&limit=100") > 0 { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
post_count="$(awk -F '\t' '$1 == "POST" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$service_list_count" == "100" ]]
[[ "$post_count" == "0" ]]
[[ "$output" != *"$RENDER_API_KEY"* ]]

for scenario in wrong-owner-deploy wrong-type-deploy; do
  run_dir="${test_root}/${scenario}"
  mkdir -p "$run_dir"
  export MOCK_RENDER_DIR="$run_dir"
  export MOCK_RENDER_SCENARIO="$scenario"

  if output="$(
    bash "${repo_root}/scripts/deploy-render-service.sh" \
      axel-delivery-native \
      "$MOCK_RENDER_COMMIT" 2>&1
  )"; then
    echo "Render service metadata mismatch unexpectedly triggered a deploy" >&2
    exit 1
  fi
  post_count="$(awk -F '\t' '$1 == "POST" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
  [[ "$post_count" == "0" ]]
  [[ "$output" != *"$RENDER_API_KEY"* ]]
done

run_dir="${test_root}/terminal-failure"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=terminal-failure

if bash "${repo_root}/scripts/deploy-render-service.sh" \
  axel-delivery-native \
  "$MOCK_RENDER_COMMIT"; then
  echo "terminal Render failure unexpectedly exited successfully" >&2
  exit 1
fi

jq -e \
  --arg commit "$MOCK_RENDER_COMMIT" \
  '.clearCache == "do_not_clear" and .commitId == $commit' \
  "${run_dir}/deploy-request.json" \
  >/dev/null

echo "Render deployment helper tests passed"
