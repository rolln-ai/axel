#!/bin/bash
# Send a Sentry cron check-in via the envelope endpoint.
#
# Usage:
#   sentry-cron-checkin.sh <status> <monitor_slug> [check_in_id] [schedule_crontab] [max_runtime_minutes] [check_in_margin_minutes]
#
#   status            = in_progress | ok | error
#   monitor_slug      = unique identifier for the cron monitor
#   check_in_id       = optional; pass the id from the in_progress call to
#                       close it out. If omitted, a new id is generated and
#                       written to $GITHUB_OUTPUT as check_in_id=<id>.
#   schedule_crontab  = optional; only honored on in_progress. Provisions
#                       the monitor server-side on first call.
#   max_runtime_minutes = optional; pairs with schedule_crontab.
#   check_in_margin_minutes = optional; start-time grace period for delayed
#                       schedulers. Pairs with schedule_crontab.
#
# Requires SENTRY_DSN to be set. If unset, exits 0 silently (no-op).
# Network errors are swallowed (non-fatal) — the wrapped job is the source
# of truth.
set -euo pipefail

STATUS="${1:-}"
MONITOR_SLUG="${2:-}"
CHECK_IN_ID="${3:-}"
SCHEDULE="${4:-}"
MAX_RUNTIME="${5:-}"
CHECK_IN_MARGIN="${6:-}"

if [ -z "${SENTRY_DSN:-}" ]; then
  echo "[sentry-checkin] SENTRY_DSN not set — skipping"
  exit 0
fi

if [ -z "$STATUS" ] || [ -z "$MONITOR_SLUG" ]; then
  echo "[sentry-checkin] usage: $0 <status> <monitor_slug> [check_in_id] [schedule] [max_runtime] [check_in_margin]" >&2
  exit 1
fi

if [ -n "$CHECK_IN_MARGIN" ] && ! [[ "$CHECK_IN_MARGIN" =~ ^[0-9]+$ ]]; then
  echo "[sentry-checkin] check_in_margin must be a non-negative integer (minutes)" >&2
  exit 1
fi

if [ -z "$CHECK_IN_ID" ]; then
  # /proc/sys/kernel/random/uuid is more portable than uuidgen on minimal containers
  CHECK_IN_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' || true)
  if [ -z "$CHECK_IN_ID" ]; then
    CHECK_IN_ID=$(python3 -c 'import uuid; print(uuid.uuid4().hex)' 2>/dev/null || true)
  fi
fi
EVENT_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' || python3 -c 'import uuid; print(uuid.uuid4().hex)')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Parse DSN: https://<key>@<host>/<project_id>
DSN_HOST=$(echo "$SENTRY_DSN" | sed -E 's|^https?://[^@]+@([^/]+)/.*|\1|')
DSN_KEY=$(echo "$SENTRY_DSN" | sed -E 's|^https?://([^@]+)@.*|\1|')
DSN_PROJECT=$(echo "$SENTRY_DSN" | sed -E 's|^https?://[^@]+@[^/]+/(.*)|\1|')
ENVELOPE_URL="https://${DSN_HOST}/api/${DSN_PROJECT}/envelope/"

ENVIRONMENT="${SENTRY_ENVIRONMENT:-production}"

PAYLOAD="{\"check_in_id\":\"$CHECK_IN_ID\",\"monitor_slug\":\"$MONITOR_SLUG\",\"status\":\"$STATUS\",\"environment\":\"$ENVIRONMENT\""
if [ -n "$SCHEDULE" ] && [ "$STATUS" = "in_progress" ]; then
  MONITOR_CONFIG="\"monitor_config\":{\"schedule\":{\"type\":\"crontab\",\"value\":\"$SCHEDULE\"}"
  if [ -n "$MAX_RUNTIME" ]; then
    MONITOR_CONFIG="${MONITOR_CONFIG},\"max_runtime\":$MAX_RUNTIME"
  fi
  if [ -n "$CHECK_IN_MARGIN" ]; then
    MONITOR_CONFIG="${MONITOR_CONFIG},\"checkin_margin\":$CHECK_IN_MARGIN"
  fi
  MONITOR_CONFIG="${MONITOR_CONFIG},\"timezone\":\"UTC\"}"
  PAYLOAD="${PAYLOAD},${MONITOR_CONFIG}"
fi
PAYLOAD="${PAYLOAD}}"

ENVELOPE=$(printf '%s\n%s\n%s\n' \
  "{\"event_id\":\"$EVENT_ID\",\"dsn\":\"$SENTRY_DSN\",\"sent_at\":\"$TIMESTAMP\"}" \
  '{"type":"check_in"}' \
  "$PAYLOAD")

if ! curl -sS --fail-with-body --output /dev/null --max-time 10 -X POST "$ENVELOPE_URL" \
  -H "content-type: application/x-sentry-envelope" \
  -H "x-sentry-auth: Sentry sentry_version=7, sentry_client=axel-ghactions/0.1, sentry_key=$DSN_KEY" \
  --data-binary "$ENVELOPE"; then
  # Do not print the response body: provider errors can echo request context.
  # The wrapped job remains authoritative, but a failed monitor signal must be
  # visible in Actions rather than silently accepted as a successful check-in.
  echo "::warning::[sentry-checkin] Sentry rejected or did not receive the check-in (non-fatal); status=$STATUS slug=$MONITOR_SLUG"
fi

# Emit check_in_id only on the in_progress call so follow-up steps can use it.
if [ -n "${GITHUB_OUTPUT:-}" ] && [ "$STATUS" = "in_progress" ]; then
  echo "check_in_id=$CHECK_IN_ID" >> "$GITHUB_OUTPUT"
fi
