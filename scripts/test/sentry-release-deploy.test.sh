#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mock_dir="$(mktemp -d)"
trap 'rm -rf "$mock_dir"' EXIT

export MOCK_CURL_DIR="$mock_dir"
export PATH="${repo_root}/scripts/test/fixtures/sentry-bin:${PATH}"
export SENTRY_AUTH_TOKEN=test-token
export SENTRY_ORG=rolln
export SENTRY_PROJECT=javascript
export SENTRY_RELEASE=0123456789abcdef0123456789abcdef01234567
export SENTRY_API_URL=https://sentry.invalid/api/0

commit_url="https://github.com/rolln-ai/axel/commit/${SENTRY_RELEASE}"
deployment_url="https://github.com/rolln-ai/axel/actions/runs/123"

bash "${repo_root}/scripts/sentry-release-deploy.sh" prepare "$commit_url"

jq -e \
  --arg release "$SENTRY_RELEASE" \
  --arg url "$commit_url" \
  '.version == $release
    and .projects == ["javascript"]
    and .url == $url
    and .refs == [{ repository: "rolln-ai/axel", commit: $release }]' \
  "${mock_dir}/release-create.json" \
  >/dev/null

bash "${repo_root}/scripts/sentry-release-deploy.sh" record \
  cloudflare/axel-ingest-worker \
  "$deployment_url"

jq -e '.dateReleased | type == "string"' \
  "${mock_dir}/release-finalize.json" \
  >/dev/null
jq -e \
  --arg url "$deployment_url" \
  '.environment == "production"
    and .name == "cloudflare/axel-ingest-worker"
    and .url == $url
    and (has("projects") | not)' \
  "${mock_dir}/deployment-create.json" \
  >/dev/null

# A rerun observes both existing objects and must not issue another finalize or
# deployment-create request.
bash "${repo_root}/scripts/sentry-release-deploy.sh" record \
  cloudflare/axel-ingest-worker \
  "$deployment_url"

finalize_count="$(awk -F '\t' '$1 == "PUT" && $2 ~ /\/releases\/[0-9a-f]+\/$/ { count++ } END { print count + 0 }' "${mock_dir}/calls.tsv")"
deployment_count="$(awk -F '\t' '$1 == "POST" && $2 ~ /\/deploys\/$/ { count++ } END { print count + 0 }' "${mock_dir}/calls.tsv")"

[[ "$finalize_count" == "1" ]]
[[ "$deployment_count" == "1" ]]

echo "sentry release/deploy helper tests passed"
