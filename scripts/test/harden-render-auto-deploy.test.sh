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
export MOCK_RENDER_COMMIT=0123456789abcdef0123456789abcdef01234567
export MOCK_RENDER_DIR="$test_root"
export MOCK_RENDER_SCENARIO=harden

bash "${repo_root}/scripts/harden-render-auto-deploy.sh"

for service_id in clickhouse delivery-native delivery-workers pull-worker; do
  jq -e '.autoDeploy == "no"' "${test_root}/patch-${service_id}.json" >/dev/null
done

patch_count="$(awk -F '\t' '$1 == "PATCH" { count++ } END { print count + 0 }' "${test_root}/calls.tsv")"
read_count="$(awk -F '\t' '$1 == "GET" && $2 ~ /\/services\/srv-/ { count++ } END { print count + 0 }' "${test_root}/calls.tsv")"
[[ "$patch_count" == "4" ]]
[[ "$read_count" == "4" ]]

echo "Render auto-deploy hardening tests passed"
