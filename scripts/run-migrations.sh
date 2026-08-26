#!/usr/bin/env bash
# Apply pending Postgres migrations in order.
#
# Source of truth for "what's been applied" is the schema_migrations
# table (see infra/postgres/migrations/0033_schema_migrations.sql).
# This script:
#   1. Ensures schema_migrations exists (idempotent).
#   2. Bootstraps an empty database from the current schema snapshot and
#      records that baseline. Historical migrations predate a true 0000 base
#      migration and cannot be replayed against an empty database.
#   3. Lists every infra/postgres/migrations/*.sql file in filename order.
#   4. Applies and records each migration newer than the ledger watermark.
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

# Managed Postgres endpoints are normally TLS-only, while the stock local
# postgres container has TLS disabled. Pick the safe usable default from the
# connection target; an explicit PGSSLMODE or sslmode query parameter wins.
if [ -z "${PGSSLMODE:-}" ]; then
  case "$DATABASE_URL" in
    *[?\&]sslmode=disable*|*://*@localhost:*|*://*@127.0.0.1:*|*://*@\[::1\]:*)
      export PGSSLMODE=disable
      ;;
    *)
      export PGSSLMODE=require
      ;;
  esac
fi

MIGRATIONS_DIR="$(cd "$(dirname "$0")/../infra/postgres/migrations" && pwd)"
SCHEMA_PATH="$(cd "$(dirname "$0")/../infra/postgres" && pwd)/schema.sql"

# Step 1 — ensure the tracker table exists AND legacy-backfill is in
# place before the loop attempts any apply. We can't rely on the
# 0033_schema_migrations.sql migration file to do this on its own: it
# sits at the END of the migration list, so without an up-front
# bootstrap the loop would attempt 0001–0032 against an existing prod
# (where they're already applied), and any non-idempotent migration
# like 0024 (`ALTER TABLE … RENAME TO data_contracts`) breaks.
#
# Existing installations that predate the ledger are registered as `legacy`,
# but only through a schema version we can prove from a migration-owned marker.
# Empty databases are created from schema.sql and registered as
# `schema-bootstrap`. On either path, a later filename is left unregistered so
# the incremental loop applies it normally.
echo "[run-migrations] ensuring schema_migrations exists + legacy backfill"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
" > /dev/null

# Detect an existing base schema before touching historical migrations.
# 0001 is a constraint change, not a base-schema migration, so replaying the
# directory against an empty database fails immediately. Bootstrap the current
# snapshot instead; future upgrades still flow through the migration ledger.
has_base_schema="$(psql "$DATABASE_URL" -At -c "
  SELECT 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'destinations' LIMIT 1
")"
baseline_marker="legacy"
if [ "$has_base_schema" != "1" ]; then
  echo "[run-migrations] empty database — applying current schema snapshot"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$SCHEMA_PATH"
  baseline_marker="schema-bootstrap"
fi

# Only register files at or below a proven watermark. A populated tracker is
# authoritative. A fresh snapshot contains every migration in this checkout.
# An existing schema with an empty tracker is different: marking the whole
# checkout as legacy would silently skip a migration added after that database
# was last upgraded. Detect a migration-owned schema marker instead. Migration
# 0064 created this table and both indexes, so their presence proves the schema
# reached 0064 under the append-only migration contract. Any later migration
# (0065+) must still flow through the apply loop.
watermark="$(psql "$DATABASE_URL" -At -c "SELECT coalesce(max(filename), '') FROM schema_migrations")"
registration_watermark="$watermark"
if [ -n "$registration_watermark" ]; then
  echo "[run-migrations] ledger watermark $watermark — registering historical files only"
elif [ "$baseline_marker" = "schema-bootstrap" ]; then
  registration_watermark="$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | sort | tail -1)"
  echo "[run-migrations] recording current migrations as the fresh schema baseline"
else
  registration_watermark="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "
    SELECT CASE
      WHEN to_regclass('public.email_verifications') IS NOT NULL
       AND to_regclass('public.email_verifications_user_idx') IS NOT NULL
       AND to_regclass('public.email_verifications_expiry_idx') IS NOT NULL
      THEN '0064_email_verifications.sql'
      ELSE ''
    END
  ")"
  if [ -z "$registration_watermark" ]; then
    echo "[run-migrations] cannot safely adopt existing schema with an empty ledger: no known baseline marker found" >&2
    echo "[run-migrations] restore schema_migrations or bring the database to the 0064 email-verifications baseline first" >&2
    exit 1
  fi
  echo "[run-migrations] existing schema with empty ledger — adopting through proven baseline $registration_watermark"
fi
for fpath in $(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort); do
  fname="$(basename "$fpath")"
  case "$fname" in
    *[!A-Za-z0-9._-]*)
      echo "[run-migrations] refusing to register $fname — unsafe filename" >&2
      exit 1
      ;;
  esac
  # Files newer than the proven registration watermark are real pending
  # migrations. Never label them as legacy merely because they are present in
  # the current checkout.
  if [[ "$fname" > "$registration_watermark" ]]; then
    continue
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
      INSERT INTO schema_migrations (filename, sha256)
      VALUES ('$fname', '$baseline_marker')
      ON CONFLICT (filename) DO NOTHING;
  " > /dev/null
done

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
