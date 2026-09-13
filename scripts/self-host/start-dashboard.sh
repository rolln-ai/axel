#!/usr/bin/env bash
set +x
set -euo pipefail

# Release images read the operator's origins at startup. Keep the original
# OpenAPI template so restarting with a new hostname cannot retain an old one.
if [ "${AXEL_DEPLOYMENT_MODE:-}" = "self-hosted" ]; then
  : "${AXEL_APP_URL:?AXEL_APP_URL is required}"
  : "${AXEL_INGEST_URL:?AXEL_INGEST_URL is required}"
  : "${AXEL_DELIVERY_URL:?AXEL_DELIVERY_URL is required}"
  cp /app/infra/self-host/openapi.template.yaml /app/apps/dashboard/public/openapi.yaml
  node /app/scripts/self-host/render-openapi.mjs \
    /app/apps/dashboard/public/openapi.yaml "$AXEL_APP_URL" "$AXEL_INGEST_URL"
fi

exec "$@"
