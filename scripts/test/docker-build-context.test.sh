#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/axel-docker-context-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

required_patterns=(
  'CLAUDE.local.md'
  '.grok'
  '.linear'
  'linear.config.json'
  '**/_*.mjs'
  '**/_*.ts'
  '**/_scratch'
  '**/*.pem'
  '**/*.key'
  '**/*.tfstate'
  '**/.netrc'
  '**/credentials.json'
)
for pattern in "${required_patterns[@]}"; do
  if ! grep -Fxq "$pattern" "$ROOT_DIR/.dockerignore"; then
    echo "missing required .dockerignore rule: $pattern" >&2
    exit 1
  fi
done

# A scratch context lets BuildKit apply the real .dockerignore without placing
# sentinel secrets in the repository or building the application image.
context="$TEST_DIR/context"
output="$TEST_DIR/output"
mkdir -p "$context/scripts" "$context/.grok" "$context/.claude" "$context/nested"
cp "$ROOT_DIR/.dockerignore" "$context/.dockerignore"
printf 'kept\n' > "$context/scripts/kept.mjs"
printf 'private\n' > "$context/scripts/_operator-diagnostic.mjs"
printf 'private\n' > "$context/CLAUDE.local.md"
printf 'private\n' > "$context/.grok/session.json"
printf 'private\n' > "$context/.claude/settings.local.json"
printf 'private\n' > "$context/linear.config.json"
printf 'private\n' > "$context/nested/customer-private.key"
printf 'private\n' > "$context/nested/credentials.json"
cat > "$context/Context.Dockerfile" <<'EOF'
FROM scratch
COPY . /
EOF

if ! docker version >/dev/null 2>&1; then
  echo "docker build-context probe skipped (Docker daemon unavailable); static rules passed"
  exit 0
fi

DOCKER_BUILDKIT=1 docker build \
  --file "$context/Context.Dockerfile" \
  --output "type=local,dest=$output" \
  "$context" >/dev/null

[ -f "$output/scripts/kept.mjs" ]
for excluded in \
  scripts/_operator-diagnostic.mjs \
  CLAUDE.local.md \
  .grok/session.json \
  .claude/settings.local.json \
  linear.config.json \
  nested/customer-private.key \
  nested/credentials.json; do
  if [ -e "$output/$excluded" ]; then
    echo ".dockerignore leaked $excluded into the build context" >&2
    exit 1
  fi
done

echo "docker build-context tests passed"
