#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/axel-vercel-deploy-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
RELEASE_SHA="0123456789abcdef0123456789abcdef01234567"

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/work"
REAL_NODE="$(command -v node)"
cat > "$TEST_DIR/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|VERCEL=%s|VERCEL_ENV=%s|CI=%s|SENTRY_RELEASE=%s|VERCEL_GIT_COMMIT_SHA=%s\n' \
  "$*" "${VERCEL:-}" "${VERCEL_ENV:-}" "${CI:-}" "${SENTRY_RELEASE:-}" \
  "${VERCEL_GIT_COMMIT_SHA:-}" >> "$MOCK_PNPM_LOG"
case " $* " in
  *" deploy "*) printf '%s\n' "${MOCK_DEPLOY_OUTPUT:-https://axel-test-0123456789.vercel.app}" ;;
esac
EOF
chmod 700 "$TEST_DIR/bin/pnpm"

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

# A direct `vercel deploy` packages the working tree with .vercelignore, not
# .gitignore. Exercise representative local-only paths with git's compatible
# ignore matcher so a future cleanup cannot put credentials or operator state
# back into the upload list.
IGNORE_FIXTURE="$TEST_DIR/vercel-ignore-fixture"
mkdir -p "$IGNORE_FIXTURE"
cp "$ROOT_DIR/.vercelignore" "$IGNORE_FIXTURE/.gitignore"
git -C "$IGNORE_FIXTURE" init -q

assert_vercel_ignored() {
  local relative_path="$1"
  mkdir -p "$IGNORE_FIXTURE/$(dirname "$relative_path")"
  touch "$IGNORE_FIXTURE/$relative_path"
  if ! git -C "$IGNORE_FIXTURE" check-ignore --no-index -q "$relative_path"; then
    echo ".vercelignore would upload local-only path: $relative_path" >&2
    exit 1
  fi
}

for relative_path in \
  '.env.production' \
  'apps/dashboard/.env.production.local' \
  '.dev.vars' \
  'apps/ingest-worker/.dev.vars.preview' \
  '.npmrc' \
  'packages/shared/.netrc' \
  '.ssh/id_ed25519' \
  'apps/dashboard/.aws/credentials' \
  '.kube/config' \
  'infra/production.tfstate.backup' \
  'secrets/server.pem' \
  'secrets/client.key' \
  'secrets/client.p12' \
  'secrets/client.pfx' \
  'secrets/signing.jks' \
  'secrets/signing.keystore' \
  'ops/id_rsa.backup' \
  'ops/id_ed25519.backup' \
  'infra/credentials.json' \
  'infra/service-account-production.json' \
  '.claude/settings.local.json' \
  'apps/dashboard/.grok/config.toml' \
  '.linear/current-issue.md' \
  'CLAUDE.local.md' \
  'linear.config.json' \
  'releases/private-rollout.json' \
  '.vercel/project.json' \
  '.wrangler/state/v3/d1.json' \
  '.selfhost/runtime.env' \
  '.playwright-mcp/session.json' \
  '_scratch/provider-response.json' \
  'scripts/_deployment-diagnostic.mjs' \
  'artifacts/visual-smoke/dashboard.png' \
  'playwright-report/index.html' \
  'test-results/results.json'; do
  assert_vercel_ignored "$relative_path"
done

for relative_path in \
  'package.json' \
  'apps/dashboard/package.json' \
  'apps/dashboard/vercel.json' \
  'apps/dashboard/app/page.tsx'; do
  mkdir -p "$IGNORE_FIXTURE/$(dirname "$relative_path")"
  touch "$IGNORE_FIXTURE/$relative_path"
  if git -C "$IGNORE_FIXTURE" check-ignore --no-index -q "$relative_path"; then
    echo ".vercelignore would omit deployable source: $relative_path" >&2
    exit 1
  fi
done

run_deploy() {
  local app="$1"
  local environment="$2"
  local release="${3-$RELEASE_SHA}"
  (
    cd "$TEST_DIR/work"
      PATH="$TEST_DIR/bin:$PATH" \
      MOCK_PNPM_LOG="$TEST_DIR/pnpm.log" \
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

: > "$TEST_DIR/pnpm.log"
: > "$TEST_DIR/node.log"
preview_output="$(run_deploy dashboard preview)"
printf '%s\n' "$preview_output" | tail -n 1 | grep -Fxq 'https://axel-test-0123456789.vercel.app'
grep -Eq 'exec vercel pull .*--environment=preview' "$TEST_DIR/pnpm.log"
grep -Eq 'exec vercel build\|' "$TEST_DIR/pnpm.log"
grep -Eq "build\|VERCEL=1\|VERCEL_ENV=preview\|CI=1\|SENTRY_RELEASE=${RELEASE_SHA}\|VERCEL_GIT_COMMIT_SHA=$" "$TEST_DIR/pnpm.log"
if grep -Eq -- '--token|build --prod|deploy --prebuilt --prod' "$TEST_DIR/pnpm.log"; then
  echo "preview deployment used production flags" >&2
  exit 1
fi

: > "$TEST_DIR/pnpm.log"
: > "$TEST_DIR/node.log"
dashboard_production_output="$(run_deploy dashboard production)"
printf '%s\n' "$dashboard_production_output" | tail -n 1 | grep -Fxq 'https://axel-test-0123456789.vercel.app'
grep -Fxq "$ROOT_DIR/scripts/verify-dashboard-r2-token.mjs --configuration-only .vercel/.env.production.local" "$TEST_DIR/node.log"
grep -Eq 'exec vercel deploy --prod --skip-domain --build-env SENTRY_RELEASE=[0-9a-f]{40} --env SENTRY_RELEASE=[0-9a-f]{40}' "$TEST_DIR/pnpm.log"
if grep -Eq -- '--token|--logs|build --prod|deploy --prebuilt' "$TEST_DIR/pnpm.log"; then
  echo "dashboard production deployment tried to materialize a Sensitive value in CI" >&2
  exit 1
fi

: > "$TEST_DIR/pnpm.log"
production_output="$(run_deploy marketing production)"
printf '%s\n' "$production_output" | tail -n 1 | grep -Fxq 'https://axel-test-0123456789.vercel.app'
grep -Eq 'exec vercel pull .*--environment=production' "$TEST_DIR/pnpm.log"
grep -Eq 'exec vercel build --prod' "$TEST_DIR/pnpm.log"
grep -Eq 'exec vercel deploy --prebuilt --prod --skip-domain' "$TEST_DIR/pnpm.log"
grep -Eq "build --prod\|VERCEL=1\|VERCEL_ENV=production\|CI=1\|SENTRY_RELEASE=${RELEASE_SHA}\|VERCEL_GIT_COMMIT_SHA=${RELEASE_SHA}$" "$TEST_DIR/pnpm.log"
if grep -Eq -- '--token' "$TEST_DIR/pnpm.log"; then
  echo "Vercel token appeared in CLI arguments" >&2
  exit 1
fi

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

provider_sentinel='provider-build-output-must-stay-private'
multiline_output="$(run_deploy dashboard production "$RELEASE_SHA" "$provider_sentinel
https://axel-test-0123456789.vercel.app")"
printf '%s\n' "$multiline_output" | grep -Fxq 'https://axel-test-0123456789.vercel.app'
if printf '%s\n' "$multiline_output" | grep -Fq "$provider_sentinel"; then
  echo "deployment helper forwarded captured provider output" >&2
  exit 1
fi

echo "Vercel deployment helper tests passed"
