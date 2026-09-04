#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

app="${1:-}"
environment="${2:-preview}"
case "$app" in
  dashboard)
    project_id="${VERCEL_PROJECT_ID_DASHBOARD:-}"
    ;;
  marketing)
    project_id="${VERCEL_PROJECT_ID_MARKETING:-}"
    ;;
  *)
    echo "Usage: scripts/vercel-preview-deploy.sh dashboard|marketing [preview|production]" >&2
    exit 2
    ;;
esac
case "$environment" in
  preview|production) ;;
  *)
    echo "Usage: scripts/vercel-preview-deploy.sh dashboard|marketing [preview|production]" >&2
    exit 2
    ;;
esac

if [ -z "${VERCEL_TOKEN:-}" ] || [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "$project_id" ]; then
  echo "VERCEL_TOKEN, VERCEL_ORG_ID, and the ${app} project id secret are required." >&2
  exit 1
fi
if [[ ! "$VERCEL_ORG_ID" =~ ^[A-Za-z0-9_-]{3,128}$ ]] \
  || [[ ! "$project_id" =~ ^[A-Za-z0-9_-]{3,128}$ ]]; then
  echo "Vercel organization and project ids must use their fixed provider format." >&2
  exit 1
fi

command -v pnpm >/dev/null

mkdir -p .vercel
VERCEL_PROJECT_ID="$project_id" node -e '
  const { VERCEL_ORG_ID: orgId, VERCEL_PROJECT_ID: projectId } = process.env;
  process.stdout.write(`${JSON.stringify({ orgId, projectId })}\n`);
' > .vercel/project.json

export VERCEL_PROJECT_ID="$project_id"
export VERCEL=1
export VERCEL_ENV="$environment"
export CI=1

if [ "$environment" = "production" ]; then
  if [[ ! "${SENTRY_RELEASE:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "SENTRY_RELEASE must be the full reviewed Git commit SHA for production deployments." >&2
    exit 1
  fi
  # A prebuilt CLI deployment does not receive every hosted-build system
  # variable. Pin release identity to the commit checked out by the workflow.
  export VERCEL_GIT_COMMIT_SHA="$SENTRY_RELEASE"
fi

# The CLI is installed from the repository's integrity-locked dependency graph.
# 58.4.4 fails `deploy --prebuilt` against this pnpm workspace with
#   ENOENT ... node_modules/.pnpm/@opentelemetry+api@1.9.1/.../context.js
# while the builder downloads deployment files. 58.4.0 is the last version
# verified green here. Bump deliberately, after a green preview run.
pnpm exec vercel pull --yes --environment="$environment"
if [ "$app" = "dashboard" ] && [ "$environment" = "production" ]; then
  # Vercel Sensitive values intentionally cannot be pulled back into CI. Prove
  # the expected configuration names here, then let the remote Vercel build run
  # the full R2/negative-permission probe inside the provider trust boundary.
  node "$ROOT_DIR/scripts/verify-dashboard-r2-token.mjs" \
    --configuration-only ".vercel/.env.production.local"
  deploy_output="$(pnpm exec vercel deploy --prod --skip-domain \
    --build-env "SENTRY_RELEASE=$SENTRY_RELEASE" \
    --env "SENTRY_RELEASE=$SENTRY_RELEASE")"
elif [ "$environment" = "production" ]; then
  pnpm exec vercel build --prod
  # Build with production configuration but leave custom domains untouched.
  # The workflow smokes this exact URL before a separate promote command.
  deploy_output="$(pnpm exec vercel deploy --prebuilt --prod --skip-domain)"
else
  pnpm exec vercel build
  deploy_output="$(pnpm exec vercel deploy --prebuilt)"
fi

# Vercel prints the deployment URL as its last line. Treat every provider/CLI
# byte as untrusted, and never forward captured provider output into CI logs.
deployment_url="$(printf '%s\n' "$deploy_output" | tail -n 1)"
if ! DEPLOYMENT_URL="$deployment_url" node - <<'NODE'
const raw = process.env.DEPLOYMENT_URL ?? "";
if (raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) process.exit(1);
let url;
try {
  url = new URL(raw);
} catch {
  process.exit(1);
}
const generatedHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/i;
if (
  url.protocol !== "https:"
  || !generatedHost.test(url.hostname)
  || url.username !== ""
  || url.password !== ""
  || url.port !== ""
  || (url.pathname !== "" && url.pathname !== "/")
  || url.search !== ""
  || url.hash !== ""
) {
  process.exit(1);
}
NODE
then
  echo "Vercel deploy did not return a valid generated deployment URL." >&2
  exit 1
fi
printf '%s\n' "$deployment_url"
