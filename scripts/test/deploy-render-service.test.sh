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
export RENDER_DEPLOY_DISCOVERY_INTERVAL_SECONDS=0
export RENDER_DEPLOY_POLL_INTERVAL_SECONDS=0
export RENDER_DEPLOY_TIMEOUT_SECONDS=5
export MOCK_RENDER_COMMIT=0123456789abcdef0123456789abcdef01234567

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

run_dir="${test_root}/existing-live"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=existing-live

bash "${repo_root}/scripts/deploy-render-service.sh" \
  axel-delivery-native \
  "$MOCK_RENDER_COMMIT"

post_count="$(awk -F '\t' '$1 == "POST" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$post_count" == "0" ]]

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
