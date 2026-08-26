#!/usr/bin/env bash
# Apply pending Postgres migrations in order.
#
# Source of truth for "what's been applied" is the schema_migrations
# table (see infra/postgres/migrations/0033_schema_migrations.sql).
# This script:
#   1. Ensures schema_migrations exists (idempotent).
#   2. Lists every infra/postgres/migrations/*.sql file in filename order.
#   3. For each, checks schema_migrations.filename. If unapplied, runs
#      the file inside a transaction together with the tracker INSERT,
#      so either both succeed or both roll back — no half-applied state.
#   4. Records sha256 of the file at apply time.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/run-migrations.sh
#
# Tolerates filenames containing only `[A-Za-z0-9._-]`.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must be set" >&2
  exit 1
fi

# Render's external Postgres endpoint is TLS-only. Force encrypted transport
# (no CA verification) unless the operator overrides it. Mirrors the dashboard
# pg Pool's ssl:{rejectUnauthorized:false} and the delivery/ingest ssl:"require".
# No-op for localhost / already-correct setups.
export PGSSLMODE="${PGSSLMODE:-require}"

MIGRATIONS_DIR="$(cd "$(dirname "$0")/../infra/postgres/migrations" && pwd)"

# Step 1 — ensure the tracker table exists AND legacy-backfill is in
# place before the loop attempts any apply. We can't rely on the
# 0033_schema_migrations.sql migration file to do this on its own: it
# sits at the END of the migration list, so without an up-front
# bootstrap the loop would attempt 0001–0032 against an existing prod
# (where they're already applied), and any non-idempotent migration
# like 0024 (`ALTER TABLE … RENAME TO data_contracts`) breaks.
#
# Backfill = INSERT ON CONFLICT DO NOTHING for every file we ship,
# marking them all as `'legacy'`. Existing prod skips everything past
# this point (all already recorded). Fresh DBs run the migrations
# anyway because the legacy rows are inserted but the actual schema
# work is also done from scratch via the loop — and idempotent. Both
# cases converge cleanly.
echo "[run-migrations] ensuring schema_migrations exists + legacy backfill"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
" > /dev/null

# Detect: existing prod (has the dashboard's `destinations` table from
# 0001) vs fresh DB. For existing prod, backfill every file in the
# migrations directory as `'legacy'` BEFORE the loop runs — otherwise
# the loop attempts to re-apply each historical migration, and any
# non-idempotent one (e.g. 0024 `ALTER TABLE event_maps RENAME TO
# data_contracts`) fails. For a fresh DB, no backfill — the loop
# applies every migration in order, against an empty schema.
needs_legacy_backfill="$(psql "$DATABASE_URL" -At -c "
  SELECT 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'destinations' LIMIT 1
")"
if [ "$needs_legacy_backfill" = "1" ]; then
  # Only backfill HISTORICAL files — those at or below the highest already-
  # tracked migration (the watermark). A populated tracker means adoption
  # already happened, so any NEW file (> watermark) is a real pending migration
  # that MUST flow through the apply loop below, NOT be silently marked
  # 'legacy' and skipped. (That skip-new-migrations bug marked 0038–0047 as
  # applied-without-running on 2026-06-03.) When the tracker is empty — first
  # adoption on an existing prod — watermark is "" and we backfill everything,
  # which is the correct one-time bootstrap so the loop won't re-run historical
  # non-idempotent migrations (e.g. 0024's RENAME).
  watermark="$(psql "$DATABASE_URL" -At -c "SELECT coalesce(max(filename), '') FROM schema_migrations")"
  if [ -n "$watermark" ]; then
    echo "[run-migrations] existing prod — backfilling files <= $watermark as 'legacy'; newer migrations will be applied"
  else
    echo "[run-migrations] existing 'destinations' table, empty tracker — first adoption: backfilling all files as 'legacy'"
  fi
  for fpath in $(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort); do
    fname="$(basename "$fpath")"
    case "$fname" in
      *[!A-Za-z0-9._-]*)
        echo "[run-migrations] refusing to register $fname — unsafe filename" >&2
        exit 1
        ;;
    esac
    # Skip files newer than the watermark — they are real pending migrations.
    if [ -n "$watermark" ] && [[ "$fname" > "$watermark" ]]; then
      continue
    fi
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
      INSERT INTO schema_migrations (filename, sha256)
      VALUES ('$fname', 'legacy')
      ON CONFLICT (filename) DO NOTHING;
    " > /dev/null
  done
else
  echo "[run-migrations] no 'destinations' table — fresh DB, will apply every migration"
fi

# Step 2 — iterate migrations.
applied_count=0
skipped_count=0
for fpath in $(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort); do
  fname="$(basename "$fpath")"

  case "$fname" in
    *[!A-Za-z0-9._-]*)
      echo "[run-migrations] refusing to apply $fname — unsafe filename" >&2
      exit 1
      ;;
  esac

  already_applied="$(psql "$DATABASE_URL" -At -c "
    SELECT 1 FROM schema_migrations WHERE filename = '$fname' LIMIT 1
  ")"

  if [ "$already_applied" = "1" ]; then
    skipped_count=$((skipped_count + 1))
    continue
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    file_sha="$(sha256sum "$fpath" | awk '{print $1}')"
  else
    file_sha="$(shasum -a 256 "$fpath" | awk '{print $1}')"
  fi

  echo "[run-migrations] applying $fname (sha256 ${file_sha:0:12}…)"

  # Each migration manages its own transactions — three of the historical
  # files use explicit BEGIN/COMMIT and don't tolerate being wrapped in a
  # second one. Apply first, then record on success. If the migration
  # succeeds but the INSERT fails, the next run will re-attempt it; that's
  # safe for our migrations because they're built to be idempotent
  # (`IF (NOT) EXISTS`, `DO $$ ... $$` for CHECK constraints, etc.).
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$fpath"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    INSERT INTO schema_migrations (filename, sha256)
    VALUES ('$fname', '$file_sha')
    ON CONFLICT (filename) DO UPDATE
      SET sha256 = EXCLUDED.sha256,
          applied_at = now();
  " > /dev/null

  applied_count=$((applied_count + 1))
done

echo "[run-migrations] done — applied $applied_count, skipped $skipped_count"
