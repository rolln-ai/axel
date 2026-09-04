#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/axel-cloudflare-secret-version-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

workflow="$ROOT_DIR/.github/workflows/sync-cloudflare-secrets.yml"
test "$(grep -Fc 'bash scripts/sync-cloudflare-secret-version.sh' "$workflow")" -eq 3
if grep -Eq 'wrangler (secret put|versions secret put)' "$workflow"; then
  echo "Cloudflare workflow still performs sequential secret writes" >&2
  exit 1
fi

mkdir -p "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/pnpm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

: "${MOCK_CLOUDFLARE_DIR:?}"
printf '%s\n' "$*" >> "$MOCK_CLOUDFLARE_DIR/calls.log"
command_line=" $* "

case "$command_line" in
  *" versions list --json "*)
    if [ -f "$MOCK_CLOUDFLARE_DIR/bulk-created" ]; then
      printf '[{"id":"version-active"},{"id":"version-new","annotations":{"workers/tag":"test-atomic-tag"}}]\n'
    elif [ "${MOCK_CLOUDFLARE_SCENARIO:-}" = "stale-latest" ]; then
      printf '[{"id":"version-active"},{"id":"version-stale"}]\n'
    else
      printf '[{"id":"version-active"}]\n'
    fi
    ;;
  *" deployments status --json "*)
    if [ -f "$MOCK_CLOUDFLARE_DIR/activated" ]; then
      printf '{"versions":[{"version_id":"version-new","percentage":100}]}\n'
    else
      printf '{"versions":[{"version_id":"version-active","percentage":100}]}\n'
    fi
    ;;
  *" versions secret bulk "*)
    input="$(cat)"
    printf '%s' "$input" > "$MOCK_CLOUDFLARE_DIR/bulk-input.json"
    touch "$MOCK_CLOUDFLARE_DIR/bulk-created"
    if [ "${MOCK_CLOUDFLARE_SCENARIO:-}" = "stage-failure" ]; then
      exit 7
    fi
    ;;
  *" versions deploy "*)
    touch "$MOCK_CLOUDFLARE_DIR/activated"
    ;;
  *)
    echo "unexpected mock pnpm invocation" >&2
    exit 98
    ;;
esac
MOCK
chmod 700 "$TEST_DIR/bin/pnpm"

run_sync() {
  local scenario="$1"
  local scenario_dir="$TEST_DIR/$scenario"
  mkdir -p "$scenario_dir"
  : > "$scenario_dir/calls.log"
  PATH="$TEST_DIR/bin:$PATH" \
    MOCK_CLOUDFLARE_DIR="$scenario_dir" \
    MOCK_CLOUDFLARE_SCENARIO="$scenario" \
    AXEL_CLOUDFLARE_SECRET_VERSION_TAG=test-atomic-tag \
    DELIVERY_SHARED_SECRET=delivery-secret-sentinel \
    SENTRY_DSN=sentry-secret-sentinel \
    bash "$ROOT_DIR/scripts/sync-cloudflare-secret-version.sh" \
      apps/router-edge DELIVERY_SHARED_SECRET SENTRY_DSN
}

success_output="$(run_sync success)"
test -f "$TEST_DIR/success/activated"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.DELIVERY_SHARED_SECRET !== "delivery-secret-sentinel") process.exit(1);
  if (value.SENTRY_DSN !== "sentry-secret-sentinel") process.exit(1);
  if (Object.keys(value).length !== 2) process.exit(1);
' "$TEST_DIR/success/bulk-input.json"
grep -Fq 'versions secret bulk --tag test-atomic-tag' "$TEST_DIR/success/calls.log"
grep -Fq 'versions deploy --version-tag test-atomic-tag --percentage 100' "$TEST_DIR/success/calls.log"
if printf '%s\n' "$success_output" | grep -Eq 'delivery-secret-sentinel|sentry-secret-sentinel'; then
  echo "secret value escaped through sync output" >&2
  exit 1
fi

if run_sync stage-failure >/dev/null 2>&1; then
  echo "staging failure unexpectedly succeeded" >&2
  exit 1
fi
test -f "$TEST_DIR/stage-failure/bulk-created"
test ! -e "$TEST_DIR/stage-failure/activated"
if grep -Fq 'versions deploy' "$TEST_DIR/stage-failure/calls.log"; then
  echo "staging failure activated a partial secret version" >&2
  exit 1
fi

if run_sync stale-latest >/dev/null 2>&1; then
  echo "inactive latest version unexpectedly passed the preflight" >&2
  exit 1
fi
test ! -e "$TEST_DIR/stale-latest/bulk-created"
test ! -e "$TEST_DIR/stale-latest/activated"

partial_dir="$TEST_DIR/partial-clickhouse"
mkdir -p "$partial_dir"
: > "$partial_dir/calls.log"
if PATH="$TEST_DIR/bin:$PATH" \
  MOCK_CLOUDFLARE_DIR="$partial_dir" \
  AXEL_CLOUDFLARE_SECRET_VERSION_TAG=test-atomic-tag \
  CLICKHOUSE_USER=partial-user \
  bash "$ROOT_DIR/scripts/sync-cloudflare-secret-version.sh" \
    apps/ingest-worker CLICKHOUSE_URL CLICKHOUSE_USER CLICKHOUSE_PASSWORD \
    >/dev/null 2>&1; then
  echo "partial ClickHouse credential set unexpectedly passed" >&2
  exit 1
fi
test ! -s "$partial_dir/calls.log"
test ! -e "$partial_dir/bulk-created"
test ! -e "$partial_dir/activated"

short_ordering_dir="$TEST_DIR/short-ordering-key"
mkdir -p "$short_ordering_dir"
: > "$short_ordering_dir/calls.log"
if PATH="$TEST_DIR/bin:$PATH" \
  MOCK_CLOUDFLARE_DIR="$short_ordering_dir" \
  AXEL_CLOUDFLARE_SECRET_VERSION_TAG=test-atomic-tag \
  ORDERING_KEY_HMAC_SECRET=short-secret \
  bash "$ROOT_DIR/scripts/sync-cloudflare-secret-version.sh" \
    apps/ingest-worker ORDERING_KEY_HMAC_SECRET \
    >/dev/null 2>&1; then
  echo "short ordering-key HMAC secret unexpectedly passed" >&2
  exit 1
fi
test ! -s "$short_ordering_dir/calls.log"
test ! -e "$short_ordering_dir/bulk-created"
test ! -e "$short_ordering_dir/activated"

echo "Cloudflare atomic secret version sync tests passed"
