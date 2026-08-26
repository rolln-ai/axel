#!/usr/bin/env bash
#
# Issue a ClickHouse `BACKUP` command that writes a full backup of the
# analytical tables to an S3-compatible bucket (Cloudflare R2).
#
# Materialized views (events_daily_mv, delivery_latest_outcomes_mv,
# delivery_base_latest_outcomes_mv) are NOT backed up — they're recomputed
# from the schema on RESTORE because they're triggers, not data. The target
# tables they populate (events_daily etc.) ARE backed up, so analytics
# survive a restore intact.
#
# Path scheme:
#   s3://<bucket>/clickhouse-backups/YYYY-MM-DD-HHMMSS/
#
# Retention is enforced by an R2 lifecycle rule (configured in the Cloudflare
# dashboard, documented in docs/runbook-clickhouse-migration.md), NOT by this
# script. Keeping retention out of band means a script bug can't delete history.

set -euo pipefail

: "${CLICKHOUSE_URL:?CLICKHOUSE_URL is required}"
: "${CLICKHOUSE_USER:?CLICKHOUSE_USER is required}"
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}"
: "${CLICKHOUSE_BACKUP_S3_ENDPOINT:?CLICKHOUSE_BACKUP_S3_ENDPOINT is required (e.g. https://<account-id>.r2.cloudflarestorage.com)}"
: "${CLICKHOUSE_BACKUP_S3_BUCKET:?CLICKHOUSE_BACKUP_S3_BUCKET is required}"
: "${CLICKHOUSE_BACKUP_S3_ACCESS_KEY:?CLICKHOUSE_BACKUP_S3_ACCESS_KEY is required}"
: "${CLICKHOUSE_BACKUP_S3_SECRET_KEY:?CLICKHOUSE_BACKUP_S3_SECRET_KEY is required}"

DATE="$(date -u +%Y-%m-%d-%H%M%S)"
DEST="${CLICKHOUSE_BACKUP_S3_ENDPOINT%/}/${CLICKHOUSE_BACKUP_S3_BUCKET}/clickhouse-backups/${DATE}"

TABLES=(
  "events"
  "route_evaluations"
  "delivery_attempts"
  "events_daily"
  "delivery_latest_outcomes"
  "delivery_base_latest_outcomes"
)

# Quote each table name and join with ", "
table_list=""
for t in "${TABLES[@]}"; do
  if [ -z "$table_list" ]; then
    table_list="TABLE ${t}"
  else
    table_list="${table_list}, TABLE ${t}"
  fi
done

# `async = 0` makes the call block until the backup finishes so the workflow
# step reflects backup status. ClickHouse logs progress to system.backups.
sql="BACKUP ${table_list} TO S3('${DEST}', '${CLICKHOUSE_BACKUP_S3_ACCESS_KEY}', '${CLICKHOUSE_BACKUP_S3_SECRET_KEY}') SETTINGS async = 0"

echo "destination: ${DEST}"
echo "tables: ${TABLES[*]}"

curl -fsS "$CLICKHOUSE_URL" \
  -H "X-ClickHouse-User: $CLICKHOUSE_USER" \
  -H "X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" \
  --data-binary "$sql"

echo
echo "backup complete: clickhouse-backups/${DATE}"
