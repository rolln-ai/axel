#!/usr/bin/env bash
set -euo pipefail

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

mkdir -p .vercel
cat > .vercel/project.json <<JSON
{"orgId":"${VERCEL_ORG_ID}","projectId":"${project_id}"}
JSON

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

# Pinned, NOT `@latest`: the CLI is a third-party dependency of a required
# check, so an upstream release can (and did) break every open PR at once.
# 58.4.4 fails `deploy --prebuilt` against this pnpm workspace with
#   ENOENT ... node_modules/.pnpm/@opentelemetry+api@1.9.1/.../context.js
# while the builder downloads deployment files. 58.4.0 is the last version
# verified green here. Bump deliberately, after a green preview run.
cli="vercel@${VERCEL_CLI_VERSION:-58.4.0}"

npx --yes "$cli" pull --yes --environment="$environment" --token "$VERCEL_TOKEN"
if [ "$environment" = "production" ]; then
  npx --yes "$cli" build --prod --token "$VERCEL_TOKEN"
  # Build with production configuration but leave custom domains untouched.
  # The workflow smokes this exact URL before a separate promote command.
  deploy_output="$(npx --yes "$cli" deploy --prebuilt --prod --skip-domain --token "$VERCEL_TOKEN")"
else
  npx --yes "$cli" build --token "$VERCEL_TOKEN"
  deploy_output="$(npx --yes "$cli" deploy --prebuilt --token "$VERCEL_TOKEN")"
fi

# Vercel prints the deployment URL as its last line. Treat every provider/CLI
# byte as untrusted before it becomes a GitHub step output or promotion target.
printf '%s\n' "$deploy_output"
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
