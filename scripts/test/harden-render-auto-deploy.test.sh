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
export MOCK_RENDER_COMMIT=0123456789abcdef0123456789abcdef01234567
run_dir="${test_root}/success"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=harden

bash "${repo_root}/scripts/harden-render-auto-deploy.sh"

for service_id in delivery-native delivery-workers pull-worker; do
  jq -e '.autoDeploy == "no"' "${run_dir}/patch-${service_id}.json" >/dev/null
done
[[ ! -e "${run_dir}/patch-clickhouse.json" ]]

patch_count="$(awk -F '\t' '$1 == "PATCH" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
read_count="$(awk -F '\t' '$1 == "GET" && $2 ~ /\/services\/srv-/ { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$patch_count" == "3" ]]
[[ "$read_count" == "3" ]]
if grep -F 'srv-clickhouse' "${run_dir}/calls.tsv" >/dev/null; then
  echo "all-service hardening unexpectedly called the ClickHouse service" >&2
  exit 1
fi

run_dir="${test_root}/exact-native"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=harden

bash "${repo_root}/scripts/harden-render-auto-deploy.sh" axel-delivery-native

patch_count="$(awk -F '\t' '$1 == "PATCH" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
read_count="$(awk -F '\t' '$1 == "GET" && $2 ~ /\/services\/srv-/ { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$patch_count" == "1" ]]
[[ "$read_count" == "1" ]]
grep -F $'PATCH\thttps://api.render.com/v1/services/srv-delivery-native' "${run_dir}/calls.tsv" >/dev/null
if grep -F 'srv-clickhouse' "${run_dir}/calls.tsv" >/dev/null; then
  echo "exact native hardening unexpectedly called the ClickHouse service" >&2
  exit 1
fi

run_dir="${test_root}/invalid-target"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"

for invalid_target in invalid-service axel-clickhouse ""; do
  if output="$(bash "${repo_root}/scripts/harden-render-auto-deploy.sh" "$invalid_target" 2>&1)"; then
    echo "invalid Render hardening target unexpectedly succeeded" >&2
    exit 1
  fi
  [[ ! -e "${run_dir}/calls.tsv" ]]
  [[ "$output" != *"$RENDER_API_KEY"* ]]
done

run_dir="${test_root}/deep-page"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=deep-page-harden

bash "${repo_root}/scripts/harden-render-auto-deploy.sh"

service_list_count="$(awk -F '\t' '$1 == "GET" && index($2, "/v1/services?ownerId=tea-test-owner&includePreviews=false&limit=100") > 0 { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
patch_count="$(awk -F '\t' '$1 == "PATCH" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$service_list_count" == "2" ]]
[[ "$patch_count" == "3" ]]
if grep -F 'srv-clickhouse' "${run_dir}/calls.tsv" >/dev/null; then
  echo "deep-page hardening unexpectedly called the ClickHouse service" >&2
  exit 1
fi
grep -F $'GET\thttps://api.render.com/v1/services?ownerId=tea-test-owner&includePreviews=false&limit=100&cursor=cursor-deep-harden' \
  "${run_dir}/calls.tsv" \
  >/dev/null

run_dir="${test_root}/duplicate-later"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO=duplicate-later-harden

if output="$(bash "${repo_root}/scripts/harden-render-auto-deploy.sh" 2>&1)"; then
  echo "duplicate Render hardening target on a later page unexpectedly succeeded" >&2
  exit 1
fi
patch_count="$(awk -F '\t' '$1 == "PATCH" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$patch_count" == "0" ]]
[[ "$output" != *"$RENDER_API_KEY"* ]]

for scenario in wrong-count-harden conflicting-count-harden autoscaling-harden; do
run_dir="${test_root}/${scenario}"
mkdir -p "$run_dir"
export MOCK_RENDER_DIR="$run_dir"
export MOCK_RENDER_SCENARIO="$scenario"

if output="$(bash "${repo_root}/scripts/harden-render-auto-deploy.sh" 2>&1)"; then
  echo "non-singleton delivery worker unexpectedly passed Render hardening" >&2
  exit 1
fi
patch_count="$(awk -F '\t' '$1 == "PATCH" { count++ } END { print count + 0 }' "${run_dir}/calls.tsv")"
[[ "$patch_count" == "0" ]]
[[ "$output" != *"$RENDER_API_KEY"* ]]
done

echo "Render auto-deploy hardening tests passed"
