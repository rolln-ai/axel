#!/usr/bin/env bash

set +x
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
worker_dir="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi

case "$worker_dir" in
  apps/ingest-worker)
    allowed_keys=" ADMIN_TOKEN DELIVERY_SHARED_SECRET SOURCE_LOOKUP_SHARED_SECRET ORDERING_KEY_HMAC_SECRET CLICKHOUSE_URL CLICKHOUSE_USER CLICKHOUSE_PASSWORD SENTRY_DSN "
    ;;
  apps/router-edge)
    allowed_keys=" DELIVERY_SHARED_SECRET SENTRY_DSN "
    ;;
  apps/delivery-edge)
    allowed_keys=" CREDENTIALS_MASTER_KEY DELIVERY_SHARED_SECRET CLICKHOUSE_URL CLICKHOUSE_USER CLICKHOUSE_PASSWORD SENTRY_DSN "
    ;;
  *)
    echo "unsupported Cloudflare Worker for secret sync" >&2
    exit 2
    ;;
esac

if [ "$#" -eq 0 ]; then
  echo "at least one Cloudflare secret name is required" >&2
  exit 2
fi

if [[ "$allowed_keys" == *" CLICKHOUSE_URL "* ]]; then
  clickhouse_value_count=0
  for name in CLICKHOUSE_URL CLICKHOUSE_USER CLICKHOUSE_PASSWORD; do
    if [ -n "${!name:-}" ]; then
      clickhouse_value_count=$((clickhouse_value_count + 1))
    fi
  done
  if [ "$clickhouse_value_count" -ne 0 ] && [ "$clickhouse_value_count" -ne 3 ]; then
    echo "ClickHouse URL, user, and password must be updated together" >&2
    exit 1
  fi
fi

secret_names=()
seen_keys=" "
for name in "$@"; do
  if [[ ! "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] \
    || [[ "$allowed_keys" != *" $name "* ]] \
    || [[ "$seen_keys" == *" $name "* ]]; then
    echo "invalid or duplicate Cloudflare secret name" >&2
    exit 2
  fi
  seen_keys+="$name "
  secret_value="${!name:-}"
  if [ "$name" = "ORDERING_KEY_HMAC_SECRET" ] \
    && [ -n "$secret_value" ] \
    && [ "${#secret_value}" -lt 32 ]; then
    echo "ORDERING_KEY_HMAC_SECRET must be at least 32 characters" >&2
    exit 1
  fi
  if [ -n "$secret_value" ]; then
    secret_names+=("$name")
  fi
  unset secret_value
done
if [ "${#secret_names[@]}" -eq 0 ]; then
  echo "no non-empty Cloudflare secrets were supplied" >&2
  exit 1
fi

version_tag="${AXEL_CLOUDFLARE_SECRET_VERSION_TAG:-secret-sync-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"
if [[ ! "$version_tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "invalid Cloudflare secret version tag" >&2
  exit 2
fi

state_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/axel-cloudflare-secret-sync.XXXXXX")"
trap 'rm -rf "$state_dir"' EXIT
chmod 700 "$state_dir"

wrangler() {
  pnpm --dir "$ROOT_DIR/$worker_dir" exec wrangler "$@"
}

read_provider_state() {
  wrangler versions list --json > "$state_dir/versions.json"
  wrangler deployments status --json > "$state_dir/deployment.json"
}

assert_single_active_latest_version() {
  local expected_tag="${1:-}"
  node - "$state_dir/versions.json" "$state_dir/deployment.json" "$expected_tag" <<'NODE'
const fs = require("node:fs");
const [versionsPath, deploymentPath, expectedTag] = process.argv.slice(2);
let versions;
let deployment;
try {
  versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));
  deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
} catch {
  process.exit(1);
}
const latest = Array.isArray(versions) ? versions.at(-1) : undefined;
const active = Array.isArray(deployment?.versions) ? deployment.versions : [];
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
if (
  !validId(latest?.id)
  || active.length !== 1
  || active[0]?.version_id !== latest.id
  || Number(active[0]?.percentage) !== 100
  || (expectedTag.length > 0 && latest?.annotations?.["workers/tag"] !== expectedTag)
) {
  process.exit(1);
}
NODE
}

# `versions secret bulk` copies the newest uploaded version. Refuse to stage if
# that version is not already serving 100% of traffic, or a stale/unreviewed
# inactive upload could be promoted along with the secrets.
read_provider_state
if ! assert_single_active_latest_version; then
  echo "Cloudflare latest Worker version is not the sole active production version" >&2
  exit 1
fi

# Values stay in the environment and pipe; only allowlisted names appear in
# argv. The provider creates one inactive version containing the complete set.
node - "${secret_names[@]}" <<'NODE' \
  | wrangler versions secret bulk \
      --tag "$version_tag" \
      --message "Atomic runtime secret sync"
const values = {};
for (const name of process.argv.slice(2)) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) process.exit(1);
  values[name] = value;
}
process.stdout.write(JSON.stringify(values));
NODE

# No production mutation occurs until the complete staged version exists.
wrangler versions deploy \
  --version-tag "$version_tag" \
  --percentage 100 \
  --message "Activate atomic runtime secret sync" \
  --yes

read_provider_state
if ! assert_single_active_latest_version "$version_tag"; then
  echo "Cloudflare secret version activation readback failed" >&2
  exit 1
fi

echo "Cloudflare Worker secrets staged and activated atomically."
