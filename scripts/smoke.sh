#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

smoke_tmp_dir="$(mktemp -d /tmp/axel-smoke.XXXXXX)"
chmod 700 "$smoke_tmp_dir"
cleanup_smoke_tmp() {
  case "$smoke_tmp_dir" in
    /tmp/axel-smoke.*) rm -rf -- "$smoke_tmp_dir" ;;
  esac
}
trap cleanup_smoke_tmp EXIT
last_body_path="$smoke_tmp_dir/last-response"

marketing_url="${AXEL_MARKETING_URL:-https://axelapp.ai}"
app_url="${AXEL_APP_URL:-https://app.axelapp.ai}"
ingest_url="${AXEL_INGEST_URL:-https://ingest.axelapp.ai}"
delivery_url="${AXEL_DELIVERY_URL:-https://axel-delivery-native.onrender.com}"

marketing_bypass_secret="${VERCEL_AUTOMATION_BYPASS_SECRET_MARKETING:-${VERCEL_AUTOMATION_BYPASS_SECRET:-}}"
dashboard_bypass_secret="${VERCEL_AUTOMATION_BYPASS_SECRET_DASHBOARD:-${VERCEL_AUTOMATION_BYPASS_SECRET:-}}"
readonly -a curl_network_args=(--connect-timeout 10 --max-time 30)

check_status() {
  local name="$1"
  local url="$2"
  local expected_regex="$3"
  local bypass_secret="${4:-}"
  local status
  if [[ -n "$bypass_secret" ]]; then
    status="$(curl "${curl_network_args[@]}" -fsS -H "x-vercel-protection-bypass: ${bypass_secret}" -o "$last_body_path" -w "%{http_code}" "$url")"
  else
    status="$(curl "${curl_network_args[@]}" -fsS -o "$last_body_path" -w "%{http_code}" "$url")"
  fi
  if [[ ! "$status" =~ $expected_regex ]]; then
    echo "Smoke check failed for ${name}: unexpected HTTP status ${status}" >&2
    exit 1
  fi
  echo "ok ${name}: ${status}"
}

check_status "marketing" "$marketing_url" "^2[0-9][0-9]$" "$marketing_bypass_secret"
check_status "dashboard-login" "${app_url%/}/login" "^2[0-9][0-9]$" "$dashboard_bypass_secret"
check_status "dashboard-status" "${app_url%/}/status" "^2[0-9][0-9]$" "$dashboard_bypass_secret"
if [[ "${AXEL_REQUIRE_OPERATIONAL_STATUS:-0}" == "1" ]] \
  && ! grep -Fq "All systems operational" "$last_body_path"; then
  echo "Smoke check failed for dashboard status: production is not fully operational" >&2
  exit 1
fi

check_status "ingest-health" "${ingest_url%/}/health" "^2[0-9][0-9]$"
check_status "delivery-health" "${delivery_url%/}/health" "^2[0-9][0-9]$"

if [[ -n "${AXEL_OPS_TEST_TOKEN:-}" ]]; then
  if [[ -n "$dashboard_bypass_secret" ]]; then
    ops_curl_args=(-H "x-vercel-protection-bypass: ${dashboard_bypass_secret}")
    ops_status="$(curl "${curl_network_args[@]}" -sS -o "$smoke_tmp_dir/sentry-response" -w "%{http_code}" -X POST \
      "${ops_curl_args[@]}" \
      -H "x-axel-ops-token: ${AXEL_OPS_TEST_TOKEN}" \
      "${app_url%/}/api/ops/sentry-test")"
  else
    ops_status="$(curl "${curl_network_args[@]}" -sS -o "$smoke_tmp_dir/sentry-response" -w "%{http_code}" -X POST \
      -H "x-axel-ops-token: ${AXEL_OPS_TEST_TOKEN}" \
      "${app_url%/}/api/ops/sentry-test")"
  fi
  if [[ "$ops_status" != "200" ]]; then
    echo "Smoke check failed for Sentry test route: expected 200, got ${ops_status}" >&2
    exit 1
  fi
  echo "ok sentry-test: ${ops_status}"
elif [[ "${AXEL_REQUIRE_SENTRY_TEST:-0}" == "1" ]]; then
  echo "Smoke check failed: Sentry transport test is required but AXEL_OPS_TEST_TOKEN is unset" >&2
  exit 1
fi

ingest_status="$(curl "${curl_network_args[@]}" -sS -o "$smoke_tmp_dir/ingest-response" -w "%{http_code}" -X POST "${ingest_url%/}/in/__smoke__")"
if [[ "$ingest_status" != "401" && "$ingest_status" != "404" ]]; then
  echo "Smoke check failed for unknown source: expected 401 or 404, got ${ingest_status}" >&2
  exit 1
fi
echo "ok ingest-unknown-source: ${ingest_status}"

if [[ -n "${AXEL_CANARY_INGEST_URL:-}" || -n "${AXEL_CANARY_RECEIPT_URL:-}" ]]; then
  if [[ -z "${AXEL_CANARY_INGEST_URL:-}" || -z "${AXEL_CANARY_RECEIPT_URL:-}" ]]; then
    echo "Smoke check failed: both AXEL_CANARY_INGEST_URL and AXEL_CANARY_RECEIPT_URL are required" >&2
    exit 1
  fi
  # A missing source cannot prove authentication works. Use the provisioned
  # canary source without its credential, then prove authenticated delivery.
  canary_auth_status="$(curl "${curl_network_args[@]}" -sS -o "$smoke_tmp_dir/canary-auth-response" -w "%{http_code}" \
    -X POST -H "content-type: application/json" --data '{}' "$AXEL_CANARY_INGEST_URL")"
  if [[ "$canary_auth_status" != "401" ]]; then
    echo "Smoke check failed for canary auth gate: expected 401, got ${canary_auth_status}" >&2
    exit 1
  fi
  echo "ok ingest-auth-gate: ${canary_auth_status}"
  node scripts/delivery-canary.mjs
  echo "ok production-delivery-canary"
elif [[ "${AXEL_REQUIRE_DELIVERY_CANARY:-0}" == "1" ]]; then
  echo "Smoke check failed: delivery canary is required but not configured" >&2
  exit 1
fi
