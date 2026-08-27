#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/axel-selfhost-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

ENV_FILE="$TEST_DIR/selfhost.env"
cat > "$ENV_FILE" <<'EOF'
AXEL_PUBLIC_URL=https://axel.example.test
AXEL_DELIVERY_PUBLIC_URL=http://delivery.example.test
AXEL_RESOURCE_PREFIX=axel-test
AXEL_INSTALLATION_ID=0123456789abcdef0123456789abcdef
CLOUDFLARE_ACCOUNT_ID=account
CLOUDFLARE_API_TOKEN=token
CLOUDFLARE_RUNTIME_API_TOKEN=runtime-token
DELIVERY_SHARED_SECRET=delivery
SOURCE_LOOKUP_SHARED_SECRET=lookup
INGEST_ADMIN_TOKEN=admin
EOF

if AXEL_SELF_HOST_ENV="$ENV_FILE" "$ROOT_DIR/scripts/axel-self-host" edge \
  >"$TEST_DIR/stdout" 2>"$TEST_DIR/stderr"; then
  echo "expected plaintext delivery URL to be rejected" >&2
  exit 1
fi

grep -q "must use https://" "$TEST_DIR/stderr"

sed 's#http://delivery.example.test#https://delivery.example.test#' "$ENV_FILE" \
  > "$TEST_DIR/weak-secret.env"
if AXEL_SELF_HOST_ENV="$TEST_DIR/weak-secret.env" "$ROOT_DIR/scripts/axel-self-host" edge \
  >"$TEST_DIR/weak-stdout" 2>"$TEST_DIR/weak-stderr"; then
  echo "expected weak internal secrets to be rejected" >&2
  exit 1
fi
grep -q "must contain at least 32 characters" "$TEST_DIR/weak-stderr"

for index in 1 2; do
  env -u AXEL_RESOURCE_PREFIX -u AXEL_INSTALLATION_ID \
    node "$ROOT_DIR/scripts/self-host/env-file.mjs" init "$TEST_DIR/generated-$index.env"
done
prefix_one="$(sed -n 's/^AXEL_RESOURCE_PREFIX=//p' "$TEST_DIR/generated-1.env")"
prefix_two="$(sed -n 's/^AXEL_RESOURCE_PREFIX=//p' "$TEST_DIR/generated-2.env")"
installation_id="$(sed -n 's/^AXEL_INSTALLATION_ID=//p' "$TEST_DIR/generated-1.env")"
publish_public_ports="$(sed -n 's/^AXEL_PUBLISH_PUBLIC_PORTS=//p' "$TEST_DIR/generated-1.env")"
[[ "$prefix_one" =~ ^axel-selfhost-[0-9a-f]{16}$ ]]
[[ "$prefix_two" =~ ^axel-selfhost-[0-9a-f]{16}$ ]]
[ "$prefix_one" != "$prefix_two" ]
[[ "$installation_id" =~ ^[0-9a-f]{32}$ ]]
[ "$publish_public_ports" = "0" ]

AXEL_PUBLIC_URL=https://axel.example.test \
  AXEL_SITE_ADDRESS=axel.example.test \
  node "$ROOT_DIR/scripts/self-host/env-file.mjs" init "$TEST_DIR/generated-public.env"
[ "$(sed -n 's/^AXEL_PUBLISH_PUBLIC_PORTS=//p' "$TEST_DIR/generated-public.env")" = "1" ]

MOCK_WRANGLER="$TEST_DIR/mock-wrangler"
cat > "$MOCK_WRANGLER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_WRANGLER_LOG"

case "${1:-} ${2:-} ${3:-} ${4:-}" in
  "whoami --json -c "*)
    printf '{}\n'
    ;;
  "r2 bucket info "*)
    printf '{"name":"axel-secure-test-raw"}\n'
    ;;
  "r2 bucket dev-url get"*)
    if [ "$MOCK_SCENARIO" = "public-dev-url" ]; then
      printf "Public access is enabled at 'https://public.example.r2.dev'.\n"
    else
      printf 'Public access via the r2.dev URL is disabled.\n'
    fi
    ;;
  "r2 bucket domain list"*)
    if [ "$MOCK_SCENARIO" = "custom-domain" ]; then
      printf "Listing custom domains connected to bucket 'axel-secure-test-raw'...\n"
      printf 'domain:  raw.example.test\nenabled: Yes\n'
    else
      printf "Listing custom domains connected to bucket 'axel-secure-test-raw'...\n"
      printf 'There are no custom domains connected to this bucket.\n'
    fi
    ;;
  "r2 bucket lifecycle list"*)
    days=30
    if [ "$MOCK_SCENARIO" = "lifecycle-mismatch" ]; then days=90; fi
    printf "Listing lifecycle rules for bucket 'axel-secure-test-raw'...\n"
    printf 'name:     axel-delete-raw\nenabled:  Yes\nprefix:   (all prefixes)\naction:   Expire objects after %s days\n' "$days"
    ;;
  "queues info "*)
    if [ "$MOCK_SCENARIO" = "queue-collision" ]; then
      printf 'Queue ID: existing-queue-id\n'
    else
      exit 1
    fi
    ;;
  *)
    printf 'unexpected mock Wrangler command: %s\n' "$*" >&2
    exit 97
    ;;
esac
EOF
chmod 700 "$MOCK_WRANGLER"

STRONG_ENV="$TEST_DIR/strong.env"
cat > "$STRONG_ENV" <<'EOF'
AXEL_PUBLIC_URL=https://axel.example.test
AXEL_DELIVERY_PUBLIC_URL=https://delivery.example.test
AXEL_RESOURCE_PREFIX=axel-secure-test
AXEL_INSTALLATION_ID=0123456789abcdef0123456789abcdef
CLOUDFLARE_ACCOUNT_ID=account
CLOUDFLARE_API_TOKEN=token
CLOUDFLARE_RUNTIME_API_TOKEN=runtime-token
DELIVERY_SHARED_SECRET=dddddddddddddddddddddddddddddddd
SOURCE_LOOKUP_SHARED_SECRET=ssssssssssssssssssssssssssssssss
INGEST_ADMIN_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EOF

sed 's/^CLOUDFLARE_RUNTIME_API_TOKEN=runtime-token$/CLOUDFLARE_RUNTIME_API_TOKEN=token/' \
  "$STRONG_ENV" > "$TEST_DIR/reused-token.env"
if AXEL_SELF_HOST_ENV="$TEST_DIR/reused-token.env" \
  "$ROOT_DIR/scripts/axel-self-host" edge >"$TEST_DIR/reused-stdout" 2>"$TEST_DIR/reused-stderr"; then
  echo "expected reuse of the provisioning token at runtime to be rejected" >&2
  exit 1
fi
grep -q "must differ from the provisioning token" "$TEST_DIR/reused-stderr"

run_edge_failure() {
  local scenario="$1"
  local expected="$2"
  local adopt="${3:-0}"
  local state="$TEST_DIR/state-$scenario"
  local stdout="$TEST_DIR/$scenario-stdout"
  local stderr="$TEST_DIR/$scenario-stderr"
  local log="$TEST_DIR/$scenario-wrangler.log"
  mkdir -p "$state"
  : > "$log"

  if [ "$scenario" = "queue-collision" ]; then
    node "$ROOT_DIR/scripts/self-host/env-file.mjs" set \
      "$state/ownership.env" AXEL_INSTALLATION_ID 0123456789abcdef0123456789abcdef
    node "$ROOT_DIR/scripts/self-host/env-file.mjs" set \
      "$state/ownership.env" OWNED_RAW_PAYLOAD_BUCKET axel-secure-test-raw
    node "$ROOT_DIR/scripts/self-host/env-file.mjs" set \
      "$state/ownership.env" OWNED_RAW_PAYLOAD_BUCKET_ACCOUNT_ID account
  fi

  if AXEL_SELF_HOST_ENV="$STRONG_ENV" \
    AXEL_SELF_HOST_STATE_DIR="$state" \
    AXEL_WRANGLER_BIN="$MOCK_WRANGLER" \
    AXEL_ADOPT_EXISTING_RESOURCES="$adopt" \
    MOCK_SCENARIO="$scenario" \
    MOCK_WRANGLER_LOG="$log" \
    "$ROOT_DIR/scripts/axel-self-host" edge >"$stdout" 2>"$stderr"; then
    echo "expected edge scenario $scenario to fail closed" >&2
    exit 1
  fi
  grep -q "$expected" "$stderr"
  if grep -q '^deploy ' "$log"; then
    echo "scenario $scenario reached Worker deployment" >&2
    exit 1
  fi
}

run_edge_failure public-dev-url "public r2.dev access" 1
run_edge_failure custom-domain "custom domain is attached" 1
run_edge_failure lifecycle-mismatch "expire objects after exactly 30 days" 1
run_edge_failure bucket-collision "without local ownership proof"
run_edge_failure queue-collision "without local ownership proof"

if grep -q 'lifecycle add' "$TEST_DIR/lifecycle-mismatch-wrangler.log"; then
  echo "mismatched lifecycle rule was mutated instead of rejected" >&2
  exit 1
fi

cp "$ROOT_DIR/apps/dashboard/public/openapi.yaml" "$TEST_DIR/openapi.yaml"
node "$ROOT_DIR/scripts/self-host/render-openapi.mjs" \
  "$TEST_DIR/openapi.yaml" \
  "https://dashboard.example.test/" \
  "https://ingest.example.test/"
grep -q "https://dashboard.example.test" "$TEST_DIR/openapi.yaml"
grep -q "https://ingest.example.test" "$TEST_DIR/openapi.yaml"
if grep -q "https://app.axelapp.ai\|https://ingest.axelapp.ai" "$TEST_DIR/openapi.yaml"; then
  echo "self-host API reference still contains Axel Cloud endpoints" >&2
  exit 1
fi

cp "$ROOT_DIR/apps/dashboard/public/openapi.yaml" "$TEST_DIR/openapi-missing-ingest.yaml"
if node "$ROOT_DIR/scripts/self-host/render-openapi.mjs" \
  "$TEST_DIR/openapi-missing-ingest.yaml" \
  "https://dashboard.example.test/" \
  >"$TEST_DIR/openapi-stdout" 2>"$TEST_DIR/openapi-stderr"; then
  echo "expected a missing self-host ingest URL to be rejected" >&2
  exit 1
fi
grep -q "usage: render-openapi.mjs" "$TEST_DIR/openapi-stderr"

echo "self-host provisioner tests passed"
