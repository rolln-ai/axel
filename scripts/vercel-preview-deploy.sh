#!/usr/bin/env bash
set -euo pipefail

app="${1:-}"
case "$app" in
  dashboard)
    project_id="${VERCEL_PROJECT_ID_DASHBOARD:-}"
    ;;
  marketing)
    project_id="${VERCEL_PROJECT_ID_MARKETING:-}"
    ;;
  *)
    echo "Usage: scripts/vercel-preview-deploy.sh dashboard|marketing" >&2
    exit 2
    ;;
esac

if [ -z "${VERCEL_TOKEN:-}" ] || [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "$project_id" ]; then
  echo "VERCEL_TOKEN, VERCEL_ORG_ID, and the ${app} project id secret are required." >&2
  exit 1
fi

mkdir -p .vercel
cat > .vercel/project.json <<JSON
{"orgId":"${VERCEL_ORG_ID}","projectId":"${project_id}"}
JSON

export VERCEL_PROJECT_ID="$project_id"

# Pinned, NOT `@latest`: the CLI is a third-party dependency of a required
# check, so an upstream release can (and did) break every open PR at once.
# 58.4.4 fails `deploy --prebuilt` against this pnpm workspace with
#   ENOENT ... node_modules/.pnpm/@opentelemetry+api@1.9.1/.../context.js
# while the builder downloads deployment files. 58.4.0 is the last version
# verified green here. Bump deliberately, after a green preview run.
cli="vercel@${VERCEL_CLI_VERSION:-58.4.0}"

npx --yes "$cli" pull --yes --environment=preview --token "$VERCEL_TOKEN"
npx --yes "$cli" build --token "$VERCEL_TOKEN"
npx --yes "$cli" deploy --prebuilt --token "$VERCEL_TOKEN"
