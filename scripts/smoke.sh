#!/usr/bin/env bash
set -euo pipefail

marketing_url="${AXEL_MARKETING_URL:-https://axelapp.ai}"
app_url="${AXEL_APP_URL:-https://app.axelapp.ai}"
ingest_url="${AXEL_INGEST_URL:-https://ingest.axelapp.ai}"
delivery_url="${AXEL_DELIVERY_URL:-https://axel-delivery-native.onrender.com}"

marketing_bypass_secret="${VERCEL_AUTOMATION_BYPASS_SECRET_MARKETING:-${VERCEL_AUTOMATION_BYPASS_SECRET:-}}"
dashboard_bypass_secret="${VERCEL_AUTOMATION_BYPASS_SECRET_DASHBOARD:-${VERCEL_AUTOMATION_BYPASS_SECRET:-}}"

check_status() {
  local name="$1"
  local url="$2"
  local expected_regex="$3"
  local bypass_secret="${4:-}"
  local status
  if [[ -n "$bypass_secret" ]]; then
    status="$(curl -fsS -H "x-vercel-protection-bypass: ${bypass_secret}" -o /tmp/axel-smoke-body -w "%{http_code}" "$url")"
  else
    status="$(curl -fsS -o /tmp/axel-smoke-body -w "%{http_code}" "$url")"
  fi
  if [[ ! "$status" =~ $expected_regex ]]; then
    echo "Smoke check failed for ${name}: ${url} returned ${status}" >&2
    head -c 500 /tmp/axel-smoke-body >&2 || true
    exit 1
  fi
  echo "ok ${name}: ${status}"
}

check_status "marketing" "$marketing_url" "^2[0-9][0-9]$" "$marketing_bypass_secret"
check_status "dashboard-login" "${app_url%/}/login" "^2[0-9][0-9]$" "$dashboard_bypass_secret"
check_status "dashboard-status" "${app_url%/}/status" "^2[0-9][0-9]$" "$dashboard_bypass_secret"
if [[ "${AXEL_REQUIRE_OPERATIONAL_STATUS:-0}" == "1" ]] \
  && ! grep -Fq "All systems operational" /tmp/axel-smoke-body; then
  echo "Smoke check failed for dashboard status: production is not fully operational" >&2
  head -c 500 /tmp/axel-smoke-body >&2 || true
  exit 1
fi

check_status "ingest-health" "${ingest_url%/}/health" "^2[0-9][0-9]$"
check_status "delivery-health" "${delivery_url%/}/health" "^2[0-9][0-9]$"

if [[ -n "${AXEL_OPS_TEST_TOKEN:-}" ]]; then
  if [[ -n "$dashboard_bypass_secret" ]]; then
    ops_curl_args=(-H "x-vercel-protection-bypass: ${dashboard_bypass_secret}")
    ops_status="$(curl -sS -o /tmp/axel-smoke-sentry -w "%{http_code}" -X POST \
      "${ops_curl_args[@]}" \
      -H "x-axel-ops-token: ${AXEL_OPS_TEST_TOKEN}" \
      "${app_url%/}/api/ops/sentry-test")"
  else
    ops_status="$(curl -sS -o /tmp/axel-smoke-sentry -w "%{http_code}" -X POST \
      -H "x-axel-ops-token: ${AXEL_OPS_TEST_TOKEN}" \
      "${app_url%/}/api/ops/sentry-test")"
  fi
  if [[ "$ops_status" != "200" ]]; then
    echo "Smoke check failed for Sentry test route: expected 200, got ${ops_status}" >&2
    head -c 500 /tmp/axel-smoke-sentry >&2 || true
    exit 1
  fi
  echo "ok sentry-test: ${ops_status}"
fi

ingest_status="$(curl -sS -o /tmp/axel-smoke-ingest -w "%{http_code}" -X POST "${ingest_url%/}/in/__smoke__")"
if [[ "$ingest_status" != "401" ]]; then
  echo "Smoke check failed for ingest auth gate: expected 401, got ${ingest_status}" >&2
  head -c 500 /tmp/axel-smoke-ingest >&2 || true
  exit 1
fi
echo "ok ingest-auth-gate: ${ingest_status}"
