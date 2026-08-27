#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/axel-vercel-deploy-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
RELEASE_SHA="0123456789abcdef0123456789abcdef01234567"

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/work"
REAL_NODE="$(command -v node)"
cat > "$TEST_DIR/bin/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|VERCEL=%s|VERCEL_ENV=%s|CI=%s|SENTRY_RELEASE=%s|VERCEL_GIT_COMMIT_SHA=%s\n' \
  "$*" "${VERCEL:-}" "${VERCEL_ENV:-}" "${CI:-}" "${SENTRY_RELEASE:-}" \
  "${VERCEL_GIT_COMMIT_SHA:-}" >> "$MOCK_NPX_LOG"
case " $* " in
  *" deploy "*) printf '%s\n' "${MOCK_DEPLOY_OUTPUT:-https://axel-test-0123456789.vercel.app}" ;;
esac
EOF
chmod 700 "$TEST_DIR/bin/npx"

cat > "$TEST_DIR/bin/node" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "$ROOT_DIR/scripts/verify-dashboard-r2-token.mjs" ]; then
  printf '%s\n' "\$*" >> "\$MOCK_NODE_LOG"
  exit 0
fi
exec "$REAL_NODE" "\$@"
EOF
chmod 700 "$TEST_DIR/bin/node"

run_deploy() {
  local app="$1"
  local environment="$2"
  local release="${3-$RELEASE_SHA}"
  (
    cd "$TEST_DIR/work"
    PATH="$TEST_DIR/bin:$PATH" \
      MOCK_NPX_LOG="$TEST_DIR/npx.log" \
      MOCK_NODE_LOG="$TEST_DIR/node.log" \
      MOCK_DEPLOY_OUTPUT="${4:-}" \
      VERCEL_TOKEN=test-token \
      VERCEL_ORG_ID=test-org \
      VERCEL_PROJECT_ID_DASHBOARD=dashboard-project \
      VERCEL_PROJECT_ID_MARKETING=marketing-project \
      SENTRY_RELEASE="$release" \
      bash "$ROOT_DIR/scripts/vercel-preview-deploy.sh" "$app" "$environment"
  )
}

: > "$TEST_DIR/npx.log"
: > "$TEST_DIR/node.log"
preview_output="$(run_deploy dashboard preview)"
printf '%s\n' "$preview_output" | tail -n 1 | grep -Fxq 'https://axel-test-0123456789.vercel.app'
grep -Eq 'vercel@58\.4\.0 pull .*--environment=preview' "$TEST_DIR/npx.log"
grep -Eq 'vercel@58\.4\.0 build --token' "$TEST_DIR/npx.log"
grep -Eq "build --token.*VERCEL=1\|VERCEL_ENV=preview\|CI=1\|SENTRY_RELEASE=${RELEASE_SHA}\|VERCEL_GIT_COMMIT_SHA=$" "$TEST_DIR/npx.log"
if grep -Eq 'build --prod|deploy --prebuilt --prod' "$TEST_DIR/npx.log"; then
  echo "preview deployment used production flags" >&2
  exit 1
fi

: > "$TEST_DIR/npx.log"
: > "$TEST_DIR/node.log"
dashboard_production_output="$(run_deploy dashboard production)"
printf '%s\n' "$dashboard_production_output" | tail -n 1 | grep -Fxq 'https://axel-test-0123456789.vercel.app'
grep -Fxq "$ROOT_DIR/scripts/verify-dashboard-r2-token.mjs .vercel/.env.production.local" "$TEST_DIR/node.log"

: > "$TEST_DIR/npx.log"
production_output="$(run_deploy marketing production)"
printf '%s\n' "$production_output" | tail -n 1 | grep -Fxq 'https://axel-test-0123456789.vercel.app'
grep -Eq 'vercel@58\.4\.0 pull .*--environment=production' "$TEST_DIR/npx.log"
grep -Eq 'vercel@58\.4\.0 build --prod --token' "$TEST_DIR/npx.log"
grep -Eq 'vercel@58\.4\.0 deploy --prebuilt --prod --skip-domain --token' "$TEST_DIR/npx.log"
grep -Eq "build --prod --token.*VERCEL=1\|VERCEL_ENV=production\|CI=1\|SENTRY_RELEASE=${RELEASE_SHA}\|VERCEL_GIT_COMMIT_SHA=${RELEASE_SHA}$" "$TEST_DIR/npx.log"

if run_deploy dashboard production short >/dev/null 2>&1; then
  echo "production deployment accepted a non-commit Sentry release" >&2
  exit 1
fi

if run_deploy dashboard invalid >/dev/null 2>&1; then
  echo "deployment helper accepted an invalid environment" >&2
  exit 1
fi

if run_deploy dashboard preview "$RELEASE_SHA" 'https://safe.vercel.app/$(touch provider-output-executed)' >/dev/null 2>&1; then
  echo "deployment helper accepted a provider URL containing shell syntax" >&2
  exit 1
fi
if [ -e "$TEST_DIR/work/provider-output-executed" ]; then
  echo "deployment helper executed provider output" >&2
  exit 1
fi

echo "Vercel deployment helper tests passed"
