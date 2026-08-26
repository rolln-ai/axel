#!/usr/bin/env bash
#
# Apply infra/clickhouse/schema.sql against $CLICKHOUSE_URL.
#
# Run from CI via .github/workflows/migrate-clickhouse.yml, or locally during
# the cutover documented in docs/runbook-clickhouse-migration.md.
#
# The schema uses CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT
# EXISTS, and WHERE NOT EXISTS guards on its seed inserts, so re-running is
# idempotent.
#
# Notes:
#   - ClickHouse's HTTP API accepts one statement per request, so we split
#     schema.sql on `;`. The schema contains no string literals with `;`, so
#     naive splitting is safe; if you add one, switch to a real SQL parser.
#   - We `-fsS` on curl so the script exits non-zero on the first failing
#     statement and prints the ClickHouse error to stderr.

set -euo pipefail

: "${CLICKHOUSE_URL:?CLICKHOUSE_URL is required}"
: "${CLICKHOUSE_USER:?CLICKHOUSE_USER is required}"
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}"

SCHEMA_PATH="${SCHEMA_PATH:-infra/clickhouse/schema.sql}"

if [ ! -f "$SCHEMA_PATH" ]; then
  echo "schema file not found: $SCHEMA_PATH" >&2
  exit 1
fi

# Strip line comments, collapse newlines to spaces, split on semicolons.
# Use `.*$` (not `[^\n]*$`) so this works on BSD sed (macOS) and GNU sed (CI).
sql=$(sed -E 's|--.*$||g' "$SCHEMA_PATH" | tr '\n' ' ')

count=0
echo "$sql" | tr ';' '\n' | while IFS= read -r stmt; do
  trimmed="$(echo "$stmt" | xargs)"
  [ -z "$trimmed" ] && continue
  count=$((count + 1))
  preview="${trimmed:0:80}"
  echo ">> [$count] ${preview}..."
  curl -fsS "$CLICKHOUSE_URL" \
    -H "X-ClickHouse-User: $CLICKHOUSE_USER" \
    -H "X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" \
    --data-binary "$trimmed"
done

echo "schema applied"
