#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/axel-selfhost-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

grep -Fq 'install --frozen-lockfile --ignore-scripts' "$ROOT_DIR/scripts/axel-self-host"
grep -Fq 'versions upload' "$ROOT_DIR/scripts/axel-self-host"
grep -Fq -- '--secrets-file' "$ROOT_DIR/scripts/axel-self-host"
if grep -Eq 'wrangler (deploy([[:space:]]|$)|secret put)' "$ROOT_DIR/scripts/axel-self-host"; then
  echo "self-host edge still uses sequential live Worker or secret mutation" >&2
  exit 1
fi

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
ORDERING_KEY_HMAC_SECRET=ordering
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
database_admin_password="$(sed -n 's/^POSTGRES_ADMIN_PASSWORD=//p' "$TEST_DIR/generated-1.env")"
database_migration_password="$(sed -n 's/^POSTGRES_MIGRATION_PASSWORD=//p' "$TEST_DIR/generated-1.env")"
database_dashboard_password="$(sed -n 's/^POSTGRES_DASHBOARD_PASSWORD=//p' "$TEST_DIR/generated-1.env")"
database_delivery_password="$(sed -n 's/^POSTGRES_DELIVERY_PASSWORD=//p' "$TEST_DIR/generated-1.env")"
previous_delivery_secret="$(sed -n 's/^DELIVERY_SHARED_SECRET_PREVIOUS=//p' "$TEST_DIR/generated-1.env")"
previous_source_secret="$(sed -n 's/^SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS=//p' "$TEST_DIR/generated-1.env")"
ordering_secret="$(sed -n 's/^ORDERING_KEY_HMAC_SECRET=//p' "$TEST_DIR/generated-1.env")"
[[ "$prefix_one" =~ ^axel-selfhost-[0-9a-f]{16}$ ]]
[[ "$prefix_two" =~ ^axel-selfhost-[0-9a-f]{16}$ ]]
[ "$prefix_one" != "$prefix_two" ]
[[ "$installation_id" =~ ^[0-9a-f]{32}$ ]]
[ "$publish_public_ports" = "0" ]
[[ "$database_admin_password" =~ ^[0-9a-f]{64}$ ]]
[[ "$database_migration_password" =~ ^[0-9a-f]{64}$ ]]
[[ "$database_dashboard_password" =~ ^[0-9a-f]{64}$ ]]
[[ "$database_delivery_password" =~ ^[0-9a-f]{64}$ ]]
[ "$database_admin_password" != "$database_migration_password" ]
[ "$database_admin_password" != "$database_dashboard_password" ]
[ "$database_admin_password" != "$database_delivery_password" ]
[ "$database_migration_password" != "$database_dashboard_password" ]
[ "$database_migration_password" != "$database_delivery_password" ]
[ "$database_dashboard_password" != "$database_delivery_password" ]
[ -z "$previous_delivery_secret" ]
[ -z "$previous_source_secret" ]
[[ "$ordering_secret" =~ ^[0-9a-f]{64}$ ]]

AXEL_PUBLIC_URL=https://axel.example.test \
  AXEL_SITE_ADDRESS=axel.example.test \
  node "$ROOT_DIR/scripts/self-host/env-file.mjs" init "$TEST_DIR/generated-public.env"
[ "$(sed -n 's/^AXEL_PUBLISH_PUBLIC_PORTS=//p' "$TEST_DIR/generated-public.env")" = "1" ]

MOCK_WRANGLER="$TEST_DIR/mock-wrangler"
cat > "$MOCK_WRANGLER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

mock_dir="$(cd "$(dirname "$0")" && pwd)"
scenario=""
worker=""
for argument in "$@"; do
  case "$argument" in
    */state-*/ingest.toml)
      state_name="$(basename "$(dirname "$argument")")"
      scenario="${state_name#state-}"
      worker="ingest"
      ;;
    */state-*/router.toml)
      state_name="$(basename "$(dirname "$argument")")"
      scenario="${state_name#state-}"
      worker="router"
      ;;
  esac
done
if [ -z "$scenario" ]; then
  echo "mock Wrangler could not determine the test scenario" >&2
  exit 98
fi

printf '%s\n' "$*" >> "$mock_dir/$scenario-wrangler.log"
compgen -e | LC_ALL=C sort -u >> "$mock_dir/$scenario-wrangler-env-names.log"

case "${1:-} ${2:-} ${3:-} ${4:-}" in
  "whoami --json -c "*)
    printf '{}\n'
    ;;
  "r2 bucket info "*)
    printf '{"name":"axel-secure-test-raw"}\n'
    ;;
  "r2 bucket dev-url get"*)
    if [ "$scenario" = "public-dev-url" ]; then
      printf "Public access is enabled at 'https://public.example.r2.dev'.\n"
    else
      printf 'Public access via the r2.dev URL is disabled.\n'
    fi
    ;;
  "r2 bucket domain list"*)
    if [ "$scenario" = "custom-domain" ]; then
      printf "Listing custom domains connected to bucket 'axel-secure-test-raw'...\n"
      printf 'domain:  raw.example.test\nenabled: Yes\n'
    else
      printf "Listing custom domains connected to bucket 'axel-secure-test-raw'...\n"
      printf 'There are no custom domains connected to this bucket.\n'
    fi
    ;;
  "r2 bucket lifecycle list"*)
    days=30
    if [ "$scenario" = "lifecycle-mismatch" ]; then days=90; fi
    printf "Listing lifecycle rules for bucket 'axel-secure-test-raw'...\n"
    printf 'name:     axel-delete-raw\nenabled:  Yes\nprefix:   (all prefixes)\naction:   Expire objects after %s days\n' "$days"
    ;;
  "queues info "*)
    if [ "$scenario" = "queue-collision" ]; then
      printf 'Queue ID: existing-queue-id\n'
    elif [[ "$scenario" == atomic-* ]]; then
      printf 'Queue ID: delivery-queue-id\nHTTP Pull Consumer\n'
    else
      exit 1
    fi
    ;;
  "versions upload "*)
    tag=""
    secret_file=""
    previous=""
    for argument in "$@"; do
      case "$previous" in
        --tag) tag="$argument" ;;
        --secrets-file) secret_file="$argument" ;;
      esac
      previous="$argument"
    done
    if [ -z "$worker" ] || [ -z "$tag" ] || [ ! -f "$secret_file" ]; then
      echo "invalid mocked Worker upload" >&2
      exit 96
    fi
    if stat -f '%Lp' "$secret_file" >/dev/null 2>&1; then
      stat -f '%Lp' "$secret_file" > "$mock_dir/$scenario-$worker-secret-mode"
    else
      stat -c '%a' "$secret_file" > "$mock_dir/$scenario-$worker-secret-mode"
    fi
    cp "$secret_file" "$mock_dir/$scenario-$worker-secrets.json"
    printf '%s' "$tag" > "$mock_dir/$scenario-$worker-tag"
    if [ "$scenario" = "atomic-stage-failure" ] && [ "$worker" = "router" ]; then
      exit 7
    fi
    ;;
  "versions deploy "*)
    tag=""
    version_id=""
    previous=""
    for argument in "$@"; do
      case "$previous" in
        --version-tag) tag="$argument" ;;
        --version-id) version_id="$argument" ;;
      esac
      previous="$argument"
    done
    if [ -z "$worker" ] || { [ -z "$tag" ] && [ -z "$version_id" ]; }; then exit 96; fi
    if [ -n "$tag" ]; then
      printf '%s' "$tag" > "$mock_dir/$scenario-$worker-active-tag"
      printf '%s' "$worker-new-version" > "$mock_dir/$scenario-$worker-active-version"
      if [ "$scenario" = "atomic-second-activation-failure" ] && [ "$worker" = "router" ]; then
        printf 'provider-version-body-sentinel\n' >&2
        exit 7
      fi
    else
      if [ "$scenario" = "atomic-rollback-failure" ] && [ "$worker" = "ingest" ]; then
        printf 'provider-version-body-sentinel\n' >&2
        exit 7
      fi
      printf '%s' "$version_id" > "$mock_dir/$scenario-$worker-active-version"
    fi
    ;;
  "triggers deploy "*)
    touch "$mock_dir/$scenario-$worker-triggers"
    if { [ "$scenario" = "atomic-trigger-failure" ] \
      || [ "$scenario" = "atomic-rollback-failure" ]; } \
      && [ "$worker" = "router" ]; then
      printf 'provider-version-body-sentinel\n' >&2
      exit 7
    fi
    ;;
  "versions list --json "*)
    tag="$(cat "$mock_dir/$scenario-$worker-tag")"
    printf '[{"id":"%s-new-version","annotations":{"workers/tag":"%s"}}]\n' "$worker" "$tag"
    ;;
  "deployments status --json "*)
    active_version="$(cat "$mock_dir/$scenario-$worker-active-version")"
    if [ "$scenario" = "atomic-readback-failure" ] \
      && [ "$worker" = "router" ] \
      && [ "$active_version" = "router-new-version" ] \
      && [ ! -e "$mock_dir/$scenario-router-readback-failed" ]; then
      touch "$mock_dir/$scenario-router-readback-failed"
      printf 'provider-version-body-sentinel\n' >&2
      exit 7
    fi
    printf '{"versions":[{"version_id":"%s","percentage":100}]}\n' "$active_version"
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
SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS=pppppppppppppppppppppppppppppppp
ORDERING_KEY_HMAC_SECRET=oooooooooooooooooooooooooooooooo
INGEST_ADMIN_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CRON_SECRET=cccccccccccccccccccccccccccccccc
POSTGRES_ADMIN_PASSWORD=AdminPassword_0000000000000000000000000000000000000000
POSTGRES_MIGRATION_PASSWORD=MigrationPassword_000000000000000000000000000000000000
POSTGRES_DASHBOARD_PASSWORD=DashboardPassword_00000000000000000000000000000000000
POSTGRES_DELIVERY_PASSWORD=DeliveryPassword_000000000000000000000000000000000000
CREDENTIALS_MASTER_KEY=0000000000000000000000000000000000000000000000000000000000000000
EOF

cp "$STRONG_ENV" "$TEST_DIR/unapproved-env-name.env"
printf '%s\n' 'NODE_OPTIONS=--require=/tmp/untrusted-self-host-hook.cjs' \
  >> "$TEST_DIR/unapproved-env-name.env"
if AXEL_SELF_HOST_ENV="$TEST_DIR/unapproved-env-name.env" \
  "$ROOT_DIR/scripts/axel-self-host" status \
  >"$TEST_DIR/unapproved-env-stdout" 2>"$TEST_DIR/unapproved-env-stderr"; then
  echo "expected an interpreter-control environment key to be rejected" >&2
  exit 1
fi
grep -q 'unapproved environment key.*NODE_OPTIONS' "$TEST_DIR/unapproved-env-stderr"

cp "$STRONG_ENV" "$TEST_DIR/duplicate-env-name.env"
printf '%s\n' 'DELIVERY_SHARED_SECRET=duplicate-must-not-win' \
  >> "$TEST_DIR/duplicate-env-name.env"
if AXEL_SELF_HOST_ENV="$TEST_DIR/duplicate-env-name.env" \
  "$ROOT_DIR/scripts/axel-self-host" status \
  >"$TEST_DIR/duplicate-env-stdout" 2>"$TEST_DIR/duplicate-env-stderr"; then
  echo "expected a duplicate environment key to be rejected" >&2
  exit 1
fi
grep -q 'duplicate environment key.*DELIVERY_SHARED_SECRET' "$TEST_DIR/duplicate-env-stderr"

REAL_NODE="$(command -v node)"
MOCK_BIN="$TEST_DIR/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == */scripts/self-host/verify-runtime-token.mjs ]]; then
  exit 0
fi
if [[ "${1:-}" == */scripts/self-host/cloudflare-worker-release.mjs ]] \
  && [ "${2:-}" = "capture-active" ]; then
  worker_name="${3:-}"
  state_path="${4:-}"
  state_dir="$(dirname "$(dirname "$state_path")")"
  scenario="${state_dir##*/state-}"
  case "$worker_name" in
    *-ingest) worker=ingest ;;
    *-router) worker=router ;;
    *) exit 96 ;;
  esac
  if [ "$scenario" = "atomic-capture-failure" ] && [ "$worker" = "router" ]; then
    printf 'provider-version-body-sentinel\n' >&2
    exit 7
  fi
  umask 077
  if [ "$scenario" = "atomic-first-install" ]; then
    printf '{"activeVersion":null}\n' > "$state_path"
  else
    printf '{"activeVersion":"%s-prior-version"}\n' "$worker" > "$state_path"
  fi
  printf 'capture-active %s\n' "$worker" >> "${AXEL_TEST_MOCK_DIR:?}/$scenario-wrangler.log"
  exit 0
fi
exec "${AXEL_TEST_REAL_NODE:?}" "$@"
EOF
chmod 700 "$MOCK_BIN/node"

sed 's/^CLOUDFLARE_RUNTIME_API_TOKEN=runtime-token$/CLOUDFLARE_RUNTIME_API_TOKEN=token/' \
  "$STRONG_ENV" > "$TEST_DIR/reused-token.env"
if AXEL_SELF_HOST_ENV="$TEST_DIR/reused-token.env" \
  "$ROOT_DIR/scripts/axel-self-host" edge >"$TEST_DIR/reused-stdout" 2>"$TEST_DIR/reused-stderr"; then
  echo "expected reuse of the provisioning token at runtime to be rejected" >&2
  exit 1
fi
grep -q "must differ from the provisioning token" "$TEST_DIR/reused-stderr"

sed 's/^SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS=.*$/SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS=short/' \
  "$STRONG_ENV" > "$TEST_DIR/weak-previous-source.env"
if PATH="$MOCK_BIN:$PATH" \
  AXEL_TEST_REAL_NODE="$REAL_NODE" \
  AXEL_TEST_MOCK_DIR="$TEST_DIR" \
  AXEL_SELF_HOST_ENV="$TEST_DIR/weak-previous-source.env" \
  AXEL_WRANGLER_BIN="$MOCK_WRANGLER" \
  "$ROOT_DIR/scripts/axel-self-host" edge \
  >"$TEST_DIR/weak-previous-source-stdout" \
  2>"$TEST_DIR/weak-previous-source-stderr"; then
  echo "expected a weak previous source credential to be rejected" >&2
  exit 1
fi
grep -q 'SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS must contain at least 32 characters' \
  "$TEST_DIR/weak-previous-source-stderr"

sed 's/^SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS=.*$/SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS=ssssssssssssssssssssssssssssssss/' \
  "$STRONG_ENV" > "$TEST_DIR/reused-previous-source.env"
if PATH="$MOCK_BIN:$PATH" \
  AXEL_TEST_REAL_NODE="$REAL_NODE" \
  AXEL_TEST_MOCK_DIR="$TEST_DIR" \
  AXEL_SELF_HOST_ENV="$TEST_DIR/reused-previous-source.env" \
  AXEL_WRANGLER_BIN="$MOCK_WRANGLER" \
  "$ROOT_DIR/scripts/axel-self-host" edge \
  >"$TEST_DIR/reused-previous-source-stdout" \
  2>"$TEST_DIR/reused-previous-source-stderr"; then
  echo "expected a reused previous source credential to be rejected" >&2
  exit 1
fi
grep -q 'SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS must differ from SOURCE_LOOKUP_SHARED_SECRET' \
  "$TEST_DIR/reused-previous-source-stderr"

run_edge_failure() {
  local scenario="$1"
  local expected="$2"
  local adopt="${3:-0}"
  local state="$TEST_DIR/state-$scenario"
  local stdout="$TEST_DIR/$scenario-stdout"
  local stderr="$TEST_DIR/$scenario-stderr"
  local log="$TEST_DIR/$scenario-wrangler.log"
  local env_names="$TEST_DIR/$scenario-wrangler-env-names.log"
  mkdir -p "$state"
  : > "$log"
  : > "$env_names"

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
    "$ROOT_DIR/scripts/axel-self-host" edge >"$stdout" 2>"$stderr"; then
    echo "expected edge scenario $scenario to fail closed" >&2
    exit 1
  fi
  grep -q "$expected" "$stderr"
  if grep -q '^deploy ' "$log"; then
    echo "scenario $scenario reached Worker deployment" >&2
    exit 1
  fi
  LC_ALL=C sort -u "$env_names" -o "$env_names"
  grep -qx 'CLOUDFLARE_ACCOUNT_ID' "$env_names"
  grep -qx 'CLOUDFLARE_API_TOKEN' "$env_names"
  while IFS= read -r name; do
    case "$name" in
      ALL_PROXY|CI|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|HOME|HTTP_PROXY|HTTPS_PROXY|LANG|LC_ALL|LC_CTYPE|NODE_EXTRA_CA_CERTS|NO_COLOR|NO_PROXY|PATH|PWD|SHLVL|SSL_CERT_DIR|SSL_CERT_FILE|TMPDIR|TZ|_|all_proxy|http_proxy|https_proxy|no_proxy) ;;
      *)
        echo "Wrangler inherited unreviewed environment variable name: $name" >&2
        exit 1
        ;;
    esac
  done < "$env_names"
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

run_atomic_edge() {
  local scenario="$1"
  local expect_success="$2"
  local state="$TEST_DIR/state-$scenario"
  local env_file="$TEST_DIR/$scenario.env"
  local stdout="$TEST_DIR/$scenario-stdout"
  local stderr="$TEST_DIR/$scenario-stderr"
  local log="$TEST_DIR/$scenario-wrangler.log"
  mkdir -p "$state"
  cp "$STRONG_ENV" "$env_file"
  printf 'AXEL_INGEST_DOMAIN=ingest.example.test\n' >> "$env_file"
  : > "$log"
  : > "$TEST_DIR/$scenario-wrangler-env-names.log"
  printf '%s' 'ingest-prior-version' > "$TEST_DIR/$scenario-ingest-active-version"
  printf '%s' 'router-prior-version' > "$TEST_DIR/$scenario-router-active-version"

  set +e
  PATH="$MOCK_BIN:$PATH" \
    AXEL_TEST_REAL_NODE="$REAL_NODE" \
    AXEL_TEST_MOCK_DIR="$TEST_DIR" \
    AXEL_SELF_HOST_ENV="$env_file" \
    AXEL_SELF_HOST_STATE_DIR="$state" \
    AXEL_WRANGLER_BIN="$MOCK_WRANGLER" \
    AXEL_ADOPT_EXISTING_RESOURCES=1 \
    "$ROOT_DIR/scripts/axel-self-host" edge >"$stdout" 2>"$stderr"
  local status=$?
  set -e
  if [ "$expect_success" = "1" ] && [ "$status" -ne 0 ]; then
    cat "$stderr" >&2
    echo "expected atomic edge scenario $scenario to succeed" >&2
    exit 1
  fi
  if [ "$expect_success" = "0" ] && [ "$status" -eq 0 ]; then
    echo "expected atomic edge scenario $scenario to fail" >&2
    exit 1
  fi
}

run_atomic_edge atomic-success 1
if grep -q '^\[\[durable_objects\.bindings\]\]' \
  "$TEST_DIR/state-atomic-success/ingest.toml"; then
  echo "small self-host ingest must use direct origin, not a Durable Object" >&2
  exit 1
fi
grep -Fq 'authenticated delivery-service source lookup on every request' \
  "$TEST_DIR/state-atomic-success/ingest.toml"
grep -Fq 'SOURCE_AUTHORITY_REQUIRED = "false"' \
  "$TEST_DIR/state-atomic-success/ingest.toml"
test "$(grep -c '^versions upload ' "$TEST_DIR/atomic-success-wrangler.log")" -eq 2
test "$(grep -c '^versions deploy ' "$TEST_DIR/atomic-success-wrangler.log")" -eq 2
test "$(grep -c '^triggers deploy ' "$TEST_DIR/atomic-success-wrangler.log")" -eq 2
test "$(cat "$TEST_DIR/atomic-success-ingest-secret-mode")" = "600"
test "$(cat "$TEST_DIR/atomic-success-router-secret-mode")" = "600"
first_upload_line="$(grep -n '^versions upload ' "$TEST_DIR/atomic-success-wrangler.log" | head -1 | cut -d: -f1)"
ingest_capture_line="$(grep -n '^capture-active ingest$' "$TEST_DIR/atomic-success-wrangler.log" | cut -d: -f1)"
router_capture_line="$(grep -n '^capture-active router$' "$TEST_DIR/atomic-success-wrangler.log" | cut -d: -f1)"
test "$ingest_capture_line" -lt "$first_upload_line"
test "$router_capture_line" -lt "$first_upload_line"
for forbidden_name in \
  ADMIN_TOKEN DELIVERY_SHARED_SECRET SOURCE_LOOKUP_SHARED_SECRET ORDERING_KEY_HMAC_SECRET \
  DELIVERY_SHARED_SECRET_PREVIOUS SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS \
  INGEST_ADMIN_TOKEN CLOUDFLARE_RUNTIME_API_TOKEN AXEL_TEST_REAL_NODE; do
  if grep -qx "$forbidden_name" "$TEST_DIR/atomic-success-wrangler-env-names.log"; then
    echo "Wrangler inherited protected environment variable: $forbidden_name" >&2
    exit 1
  fi
done
node - "$TEST_DIR/atomic-success-ingest-secrets.json" \
  "$TEST_DIR/atomic-success-router-secrets.json" <<'NODE'
const fs = require("node:fs");
const ingest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const router = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (JSON.stringify(Object.keys(ingest).sort()) !== JSON.stringify([
  "ADMIN_TOKEN",
  "DELIVERY_SHARED_SECRET",
  "ORDERING_KEY_HMAC_SECRET",
  "SOURCE_LOOKUP_SHARED_SECRET",
])) process.exit(1);
if (JSON.stringify(Object.keys(router)) !== JSON.stringify(["DELIVERY_SHARED_SECRET"])) {
  process.exit(1);
}
if (ingest.ADMIN_TOKEN !== "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") process.exit(1);
if (ingest.DELIVERY_SHARED_SECRET !== "dddddddddddddddddddddddddddddddd") process.exit(1);
if (ingest.SOURCE_LOOKUP_SHARED_SECRET !== "ssssssssssssssssssssssssssssssss") process.exit(1);
if (ingest.ORDERING_KEY_HMAC_SECRET !== "oooooooooooooooooooooooooooooooo") process.exit(1);
if (router.DELIVERY_SHARED_SECRET !== "dddddddddddddddddddddddddddddddd") process.exit(1);
NODE
grep -qx 'NEXT_PUBLIC_AXEL_INGEST_URL=https://ingest.example.test' \
  "$TEST_DIR/atomic-success.env"
if find "$TEST_DIR/state-atomic-success" -name '.worker-release.*' -print -quit | grep -q .; then
  echo "protected Worker release directory was not removed" >&2
  exit 1
fi
if grep -Eq 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|dddddddddddddddddddddddddddddddd|ssssssssssssssssssssssssssssssss|oooooooooooooooooooooooooooooooo|runtime-token|^token$' \
  "$TEST_DIR/atomic-success-stdout" \
  "$TEST_DIR/atomic-success-stderr" \
  "$TEST_DIR/atomic-success-wrangler.log"; then
  echo "Worker secret escaped through command output or argv" >&2
  exit 1
fi

run_atomic_edge atomic-first-install 1
test "$(grep -c '^versions upload ' "$TEST_DIR/atomic-first-install-wrangler.log")" -eq 2
test "$(grep -c '^versions deploy ' "$TEST_DIR/atomic-first-install-wrangler.log")" -eq 2
test "$(cat "$TEST_DIR/atomic-first-install-ingest-active-version")" = "ingest-new-version"
test "$(cat "$TEST_DIR/atomic-first-install-router-active-version")" = "router-new-version"

run_atomic_edge atomic-capture-failure 0
grep -q 'active-version capture failed; no Worker version was staged' \
  "$TEST_DIR/atomic-capture-failure-stderr"
if grep -q '^versions upload ' "$TEST_DIR/atomic-capture-failure-wrangler.log"; then
  echo "active-version capture failure reached Worker staging" >&2
  exit 1
fi
if grep -q 'provider-version-body-sentinel' \
  "$TEST_DIR/atomic-capture-failure-stdout" \
  "$TEST_DIR/atomic-capture-failure-stderr"; then
  echo "provider response body escaped during active-version capture" >&2
  exit 1
fi

# The router upload fails only after the ingest version has staged. Neither
# staged version may be activated when that mid-stage failure occurs.
run_atomic_edge atomic-stage-failure 0
test "$(grep -c '^versions upload ' "$TEST_DIR/atomic-stage-failure-wrangler.log")" -eq 2
if grep -q '^versions deploy ' "$TEST_DIR/atomic-stage-failure-wrangler.log"; then
  echo "mid-stage failure activated a subset of Worker versions" >&2
  exit 1
fi
if grep -q '^triggers deploy ' "$TEST_DIR/atomic-stage-failure-wrangler.log"; then
  echo "mid-stage failure mutated Worker triggers" >&2
  exit 1
fi
grep -q 'production was not activated' "$TEST_DIR/atomic-stage-failure-stderr"
if find "$TEST_DIR/state-atomic-stage-failure" -name '.worker-release.*' -print -quit | grep -q .; then
  echo "failed Worker release left its protected temp directory behind" >&2
  exit 1
fi

assert_recovered_release() {
  local scenario="$1"
  local expected_message="$2"
  run_atomic_edge "$scenario" 0
  grep -q "$expected_message" "$TEST_DIR/$scenario-stderr"
  grep -q 'restored every prior active deployment' "$TEST_DIR/$scenario-stderr"
  test "$(cat "$TEST_DIR/$scenario-ingest-active-version")" = "ingest-prior-version"
  test "$(cat "$TEST_DIR/$scenario-router-active-version")" = "router-prior-version"
  test "$(grep -c -- '--version-id .*prior-version' "$TEST_DIR/$scenario-wrangler.log")" -eq 2
  if grep -q 'provider-version-body-sentinel' \
    "$TEST_DIR/$scenario-stdout" "$TEST_DIR/$scenario-stderr"; then
    echo "provider response body escaped during $scenario" >&2
    exit 1
  fi
  if find "$TEST_DIR/state-$scenario" -name '.worker-release.*' -print -quit | grep -q .; then
    echo "$scenario left its protected release directory behind" >&2
    exit 1
  fi
}

assert_recovered_release atomic-second-activation-failure 'Worker version activation failed'
assert_recovered_release atomic-trigger-failure 'Worker trigger deployment failed'
assert_recovered_release atomic-readback-failure 'Worker activation readback failed'

run_atomic_edge atomic-rollback-failure 0
grep -q 'Worker trigger deployment failed' "$TEST_DIR/atomic-rollback-failure-stderr"
grep -q 'ingest Worker rollback activation failed' "$TEST_DIR/atomic-rollback-failure-stderr"
grep -q 'recovery is incomplete' "$TEST_DIR/atomic-rollback-failure-stderr"
test "$(cat "$TEST_DIR/atomic-rollback-failure-ingest-active-version")" = "ingest-new-version"
test "$(cat "$TEST_DIR/atomic-rollback-failure-router-active-version")" = "router-prior-version"
test "$(grep -c -- '--version-id .*prior-version' "$TEST_DIR/atomic-rollback-failure-wrangler.log")" -eq 2
if grep -q 'provider-version-body-sentinel' \
  "$TEST_DIR/atomic-rollback-failure-stdout" \
  "$TEST_DIR/atomic-rollback-failure-stderr"; then
  echo "provider response body escaped during failed recovery" >&2
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
