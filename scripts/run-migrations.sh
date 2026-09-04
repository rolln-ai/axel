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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
psql_safe() {
  node "$SCRIPT_DIR/psql-safe.mjs" "$@"
}

# Managed Postgres endpoints are normally TLS-only, while the stock local
# postgres container has TLS disabled. Pick the safe usable default from the
# connection target. CONTROL_PLANE_DB_SSL_VERIFY=true raises the remote default
# to verify-full. An explicit PGSSLMODE or sslmode query parameter wins.
if [ -z "${PGSSLMODE:-}" ]; then
  case "$DATABASE_URL" in
    *[?\&]sslmode=disable*|*://*@localhost:*|*://*@127.0.0.1:*|*://*@\[::1\]:*)
      export PGSSLMODE=disable
      ;;
    *)
      if [ "${CONTROL_PLANE_DB_SSL_VERIFY:-}" = "true" ]; then
        export PGSSLMODE=verify-full
      else
        export PGSSLMODE=require
      fi
      ;;
  esac
fi

MIGRATIONS_DIR="$(cd "$SCRIPT_DIR/../infra/postgres/migrations" && pwd)"
SCHEMA_PATH="$(cd "$SCRIPT_DIR/../infra/postgres" && pwd)/schema.sql"

migration_sha256() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

# Never touch a database with an unchecked checkout. This is repeated here so
# a manual dispatch cannot bypass the CI validation gate.
node "$SCRIPT_DIR/check-postgres-migrations.mjs"

# Reject ambiguous ordering before touching the database. Migration 0025 has a
# known historical collision that was already applied before the ledger
# existed. It remains immutable; every new number must be unique.
for fpath in "$MIGRATIONS_DIR"/*.sql; do
  fname="$(basename "$fpath")"
  if [[ ! "$fname" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]]; then
    echo "[run-migrations] invalid migration filename: $fname" >&2
    exit 1
  fi
done
duplicate_numbers="$(
  find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -exec basename {} \; \
    | cut -c1-4 | sort | uniq -d
)"
for number in $duplicate_numbers; do
  if [ "$number" = "0025" ]; then
    actual_0025="$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '0025_*.sql' -exec basename {} \; | sort)"
    expected_0025="$(printf '%s\n' 0025_destinations_strip_route_bound_config.sql 0025_edkg_foundation.sql | sort)"
    if [ "$actual_0025" = "$expected_0025" ]; then
      continue
    fi
  fi
  echo "[run-migrations] duplicate migration number: $number" >&2
  exit 1
done

# Every new migration must run inside the runner's transaction together with
# its ledger insert. Six older files predate that rule. Their exact content is
# pinned here because their own transaction control or concurrent index build
# prevents the ordinary wrapper from being used safely.
historical_exception_hash() {
  local name="$1"
  local mode="$2"
  case "$name:$mode" in
    0001_destination_types.sql:explicit_transaction)
      printf '%s' '38f7974a1d69c306af06c4885c7c8bdd21ad308e37f234376e0c45d4d3d89702'
      ;;
    0038_drop_edkg.sql:explicit_transaction)
      printf '%s' 'ecc270924f37e6a5b8d8051ecb196542e9284b11234af6549896369fc6ffc61a'
      ;;
    0048_retention_caps.sql:explicit_transaction)
      printf '%s' '73acf1f93bcb14f524435846ccd6bcca0031d0325438d815b6531905255a0a8e'
      ;;
    0058_destinations_bigquery_type.sql:explicit_transaction)
      printf '%s' 'c2b6e59775b6d81ce6823cc54507fd0025d4454bb117d0b88f543b91f964f4d3'
      ;;
    0059_pull_sync_partial_status.sql:explicit_transaction)
      printf '%s' 'f56b18030b61a45ac9f0196699c07f869cc1b038b7a9458e2e85ae2a86d613c8'
      ;;
    0060_delivery_idempotency_workspace_index.sql:concurrent_index)
      printf '%s' '67b60981ab0302e610c57274c3c3a8eb71376e6606359c4d48522f0d1b7c5038'
      ;;
  esac
}

for fpath in $(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort); do
  fname="$(basename "$fpath")"
  if ! transaction_mode="$(
    node "$SCRIPT_DIR/postgres-migration-safety.mjs" --transaction-mode "$fpath"
  )"; then
    echo "[run-migrations] could not classify transaction safety for $fname" >&2
    exit 1
  fi
  if [ "$transaction_mode" = "atomic" ]; then
    continue
  fi
  expected_exception_hash="$(historical_exception_hash "$fname" "$transaction_mode")"
  if [ -z "$expected_exception_hash" ]; then
    echo "[run-migrations] $fname cannot use the required atomic migration wrapper" >&2
    exit 1
  fi
  if [ "$(migration_sha256 "$fpath")" != "$expected_exception_hash" ]; then
    echo "[run-migrations] immutable historical transaction exception changed: $fname" >&2
    exit 1
  fi
done

if [[ ! "${DATABASE_MIGRATION_ROLE:-}" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "[run-migrations] DATABASE_MIGRATION_ROLE must name the stable owner role" >&2
  exit 1
fi
if [[ ! "${DATABASE_MIGRATION_LOGIN_ROLE:-}" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "[run-migrations] DATABASE_MIGRATION_LOGIN_ROLE must name the replaceable login role" >&2
  exit 1
fi
if [ "$DATABASE_MIGRATION_ROLE" = "$DATABASE_MIGRATION_LOGIN_ROLE" ]; then
  echo "[run-migrations] migration owner and login roles must be distinct" >&2
  exit 1
fi
expected_transitional_owner="0"
if [ -n "${DATABASE_TRANSITIONAL_OWNER_LOGIN_ROLE:-}" ]; then
  if [ "$DATABASE_TRANSITIONAL_OWNER_LOGIN_ROLE" != "$DATABASE_MIGRATION_ROLE" ]; then
    echo "[run-migrations] transitional owner must exactly match the stable owner role" >&2
    exit 1
  fi
  expected_transitional_owner="1"
fi
expected_canary_role="${DATABASE_CANARY_WRITER_ROLE:-}"
if [ -n "$expected_canary_role" ] \
  && [[ ! "$expected_canary_role" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "[run-migrations] DATABASE_CANARY_WRITER_ROLE is invalid" >&2
  exit 1
fi
if [[ ! "${DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES:-}" =~ ^[01]$ ]]; then
  echo "[run-migrations] DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES must be 0 or 1" >&2
  exit 1
fi
if [[ ! "${DATABASE_VERIFY_CAPABILITY_ROLE:-}" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "[run-migrations] DATABASE_VERIFY_CAPABILITY_ROLE is invalid" >&2
  exit 1
fi
if [ -z "${DATABASE_RUNTIME_CAPABILITY_ROLES:-}" ] \
  || [[ "$DATABASE_RUNTIME_CAPABILITY_ROLES" == ,* ]] \
  || [[ "$DATABASE_RUNTIME_CAPABILITY_ROLES" == *, ]] \
  || [[ "$DATABASE_RUNTIME_CAPABILITY_ROLES" == *,,* ]]; then
  echo "[run-migrations] DATABASE_RUNTIME_CAPABILITY_ROLES is invalid" >&2
  exit 1
fi
expected_runtime_capabilities=""
IFS=',' read -r -a runtime_capability_roles <<< "$DATABASE_RUNTIME_CAPABILITY_ROLES"
for capability_role in "${runtime_capability_roles[@]}"; do
  if [[ ! "$capability_role" =~ ^[a-z][a-z0-9_]{2,62}$ ]] \
    || [ "$capability_role" = "$DATABASE_MIGRATION_ROLE" ] \
    || [ "$capability_role" = "$DATABASE_MIGRATION_LOGIN_ROLE" ] \
    || [ "$capability_role" = "$DATABASE_VERIFY_CAPABILITY_ROLE" ] \
    || [[ ",$expected_runtime_capabilities," == *",$capability_role,"* ]]; then
    echo "[run-migrations] DATABASE_RUNTIME_CAPABILITY_ROLES is invalid" >&2
    exit 1
  fi
  if [ -z "$expected_runtime_capabilities" ]; then
    expected_runtime_capabilities="$capability_role"
  else
    expected_runtime_capabilities="$expected_runtime_capabilities,$capability_role"
  fi
done
expected_migration_logins="$DATABASE_MIGRATION_LOGIN_ROLE"
if [ -n "${DATABASE_MIGRATION_EXISTING_LOGIN_ROLES:-}" ]; then
  IFS=',' read -r -a existing_migration_logins <<< "$DATABASE_MIGRATION_EXISTING_LOGIN_ROLES"
  for login_role in "${existing_migration_logins[@]}"; do
    if [[ ! "$login_role" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
      echo "[run-migrations] DATABASE_MIGRATION_EXISTING_LOGIN_ROLES is invalid" >&2
      exit 1
    fi
    if [ "$login_role" = "$DATABASE_MIGRATION_ROLE" ] \
      || [[ ",$expected_migration_logins," == *",$login_role,"* ]]; then
      echo "[run-migrations] migration login roles must be distinct" >&2
      exit 1
    fi
    expected_migration_logins="$expected_migration_logins,$login_role"
  done
fi
expected_owner_parent_roles=""
if [ -n "${DATABASE_MIGRATION_OWNER_PARENT_ROLES:-}" ]; then
  if [[ "$DATABASE_MIGRATION_OWNER_PARENT_ROLES" == ,* ]] \
    || [[ "$DATABASE_MIGRATION_OWNER_PARENT_ROLES" == *, ]] \
    || [[ "$DATABASE_MIGRATION_OWNER_PARENT_ROLES" == *,,* ]]; then
    echo "[run-migrations] DATABASE_MIGRATION_OWNER_PARENT_ROLES is invalid" >&2
    exit 1
  fi
  IFS=',' read -r -a owner_parent_roles <<< "$DATABASE_MIGRATION_OWNER_PARENT_ROLES"
  for parent_role in "${owner_parent_roles[@]}"; do
    if [[ ! "$parent_role" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
      echo "[run-migrations] DATABASE_MIGRATION_OWNER_PARENT_ROLES is invalid" >&2
      exit 1
    fi
    if [[ ",$expected_owner_parent_roles," == *",$parent_role,"* ]]; then
      echo "[run-migrations] DATABASE_MIGRATION_OWNER_PARENT_ROLES contains a duplicate" >&2
      exit 1
    fi
    if [ -z "$expected_owner_parent_roles" ]; then
      expected_owner_parent_roles="$parent_role"
    else
      expected_owner_parent_roles="$expected_owner_parent_roles,$parent_role"
    fi
  done
fi
export DATABASE_MIGRATION_ROLE_REQUIRED=1

preflight_migration_role() {
  local verdict
  verdict="$(psql_safe -Atq -v ON_ERROR_STOP=1 \
    -v expected_owner_role="$DATABASE_MIGRATION_ROLE" \
    -v expected_login_role="$DATABASE_MIGRATION_LOGIN_ROLE" \
    -v expected_login_roles_csv="$expected_migration_logins" \
    -v expected_owner_parent_roles_csv="$expected_owner_parent_roles" \
    -v expected_owner_createrole="$DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES" \
    -v expected_transitional_owner="$expected_transitional_owner" \
    -v expected_canary_role="$expected_canary_role" \
    -v expected_runtime_capability_roles_csv="$expected_runtime_capabilities" \
    -v expected_verify_capability_role="$DATABASE_VERIFY_CAPABILITY_ROLE" \
    -f "$SCRIPT_DIR/verify-database-migration-role.sql")"
  if [ "$verdict" != "1" ]; then
    echo "[run-migrations] migration role or public schema is not safely sealed" >&2
    exit 1
  fi
}

role_state_fingerprint() {
  local fingerprint
  fingerprint="$(psql_safe -Atq -v ON_ERROR_STOP=1 -c "
    WITH role_state AS (
      SELECT COALESCE(
        pg_catalog.string_agg(
          pg_catalog.format(
            '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
            role.oid, role.rolname, role.rolsuper, role.rolinherit,
            role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
            role.rolreplication, role.rolbypassrls, role.rolconnlimit,
            COALESCE(role.rolconfig::text, '')
          ),
          E'\\n' ORDER BY role.oid
        ),
        ''
      ) AS value
      FROM pg_catalog.pg_roles role
    ), membership_state AS (
      SELECT COALESCE(
        pg_catalog.string_agg(
          pg_catalog.format(
            '%s|%s|%s|%s|%s|%s',
            membership.roleid, membership.member, membership.grantor,
            membership.admin_option, membership.inherit_option,
            membership.set_option
          ),
          E'\\n' ORDER BY membership.roleid, membership.member, membership.grantor
        ),
        ''
      ) AS value
      FROM pg_catalog.pg_auth_members membership
    )
    SELECT pg_catalog.md5(role_state.value || E'\\n--memberships--\\n' || membership_state.value)
      FROM role_state CROSS JOIN membership_state
  ")"
  if [[ ! "$fingerprint" =~ ^[0-9a-f]{32}$ ]]; then
    echo "[run-migrations] could not fingerprint database roles" >&2
    exit 1
  fi
  printf '%s' "$fingerprint"
}

assert_role_state_unchanged() {
  local expected="$1"
  local actual
  actual="$(role_state_fingerprint)"
  if [ "$actual" != "$expected" ]; then
    echo "[run-migrations] migration changed role attributes or memberships" >&2
    exit 1
  fi
}

preflight_migration_role
initial_role_state="$(role_state_fingerprint)"

# Capture true target emptiness before creating the migration ledger. A target
# with any pre-existing public object but no base schema is partial/corrupt, not
# a fresh database, and must never receive the snapshot opportunistically.
initial_public_object_count="$(psql_safe -Atq -v ON_ERROR_STOP=1 -c "
  SELECT
    (SELECT count(*)
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S'))
    + (SELECT count(*)
         FROM pg_catalog.pg_proc routine
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'public')
    + (SELECT count(*)
         FROM pg_catalog.pg_type type
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type.typnamespace
        WHERE namespace.nspname = 'public')
")"
if [[ ! "$initial_public_object_count" =~ ^[0-9]+$ ]]; then
  echo "[run-migrations] could not establish target emptiness" >&2
  exit 1
fi
has_base_schema="$(psql_safe -Atq -c "
  SELECT (pg_catalog.to_regclass('public.destinations') IS NOT NULL)::integer
")"
if [ "$has_base_schema" != "1" ] && [ "$initial_public_object_count" != "0" ]; then
  echo "[run-migrations] refusing snapshot bootstrap on a non-empty partial target" >&2
  exit 1
fi
has_migration_ledger="$(psql_safe -Atq -c "
  SELECT (pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL)::integer
")"
if [[ ! "$has_migration_ledger" =~ ^[01]$ ]]; then
  echo "[run-migrations] could not establish migration ledger state" >&2
  exit 1
fi

# Step 1 — establish the ledger and its baseline atomically. A fresh target's
# ledger, complete schema snapshot, and every schema-bootstrap marker commit in
# one transaction; a crash cannot strand a final schema behind a partial
# watermark.
write_registration_sql() {
  local output_path="$1"
  local marker="$2"
  local registration_watermark="$3"
  : > "$output_path"
  for fpath in $(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort); do
    fname="$(basename "$fpath")"
    case "$fname" in
      *[!A-Za-z0-9._-]*)
        echo "[run-migrations] refusing to register $fname — unsafe filename" >&2
        exit 1
        ;;
    esac
    if [[ "$fname" > "$registration_watermark" ]]; then
      continue
    fi
    printf "INSERT INTO public.schema_migrations (filename, sha256) VALUES ('%s', '%s') ON CONFLICT (filename) DO NOTHING;\n" \
      "$fname" "$marker" >> "$output_path"
  done
}

validate_ledger_prefix() {
  local ledger_path expected_path ledger_name watermark fpath fname
  ledger_path="$(mktemp)"
  expected_path="$(mktemp)"
  chmod 600 "$ledger_path" "$expected_path"
  psql_safe -Atq -v ON_ERROR_STOP=1 \
    -c 'SELECT filename FROM public.schema_migrations ORDER BY filename COLLATE "C"' \
    > "$ledger_path"

  while IFS= read -r ledger_name; do
    if [[ ! "$ledger_name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] \
      || [ ! -f "$MIGRATIONS_DIR/$ledger_name" ]; then
      rm -f "$ledger_path" "$expected_path"
      echo "[run-migrations] migration ledger contains an unknown filename" >&2
      return 1
    fi
  done < "$ledger_path"

  watermark="$(tail -n 1 "$ledger_path")"
  if [ -z "$watermark" ]; then
    rm -f "$ledger_path" "$expected_path"
    printf '%s' ""
    return 0
  fi
  for fpath in $(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort); do
    fname="$(basename "$fpath")"
    if [[ "$fname" > "$watermark" ]]; then
      continue
    fi
    printf '%s\n' "$fname" >> "$expected_path"
  done
  if ! cmp -s "$ledger_path" "$expected_path"; then
    rm -f "$ledger_path" "$expected_path"
    echo "[run-migrations] migration ledger is not an exact contiguous repository prefix" >&2
    return 1
  fi
  rm -f "$ledger_path" "$expected_path"
  printf '%s' "$watermark"
}

registration_file="$(mktemp)"
chmod 600 "$registration_file"
trap 'rm -f "$registration_file"' EXIT
baseline_marker="legacy"

if [ "$has_base_schema" != "1" ]; then
  echo "[run-migrations] empty database — applying atomic schema baseline"
  baseline_marker="schema-bootstrap"
  registration_watermark="$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | sort | tail -1)"
  write_registration_sql "$registration_file" "$baseline_marker" "$registration_watermark"
  psql_safe -v ON_ERROR_STOP=1 -q -1 \
    -c "SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'axel:postgres:migrations:' || pg_catalog.current_database(),
        0
      )
    )" \
    -f "$SCRIPT_DIR/ensure-database-migration-ledger.sql" \
    -f "$SCHEMA_PATH" \
    -f "$registration_file" > /dev/null
  preflight_migration_role
  assert_role_state_unchanged "$initial_role_state"
else
  # A populated tracker is authoritative. Object-name heuristics cannot prove
  # that every historical migration landed, so an empty ledger on a non-empty
  # database requires operator recovery instead of automatic backfill.
  if [ "$has_migration_ledger" != "1" ]; then
    echo "[run-migrations] refusing a non-empty database without a migration ledger" >&2
    echo "[run-migrations] restore the reviewed schema_migrations records before retrying" >&2
    exit 1
  fi
  watermark="$(validate_ledger_prefix)"
  registration_watermark="$watermark"
  if [ -n "$registration_watermark" ]; then
    echo "[run-migrations] ledger watermark $watermark — registering historical files only"
  else
    echo "[run-migrations] refusing a non-empty database with an empty migration ledger" >&2
    echo "[run-migrations] restore the reviewed schema_migrations records before retrying" >&2
    exit 1
  fi
fi

rm -f "$registration_file"
trap - EXIT

# Step 2 — build one psql program for every pending migration. A session-level
# advisory lock spans the full program. Ordinary migrations run inside a
# transaction with their ledger insert, so any statement or ledger failure
# rolls both back. The immutable historical exceptions retain their original
# transaction behavior, but the same advisory lock still serializes them.
migration_driver_file="$(mktemp)"
chmod 600 "$migration_driver_file"
trap 'rm -f "$migration_driver_file"' EXIT
printf '%s\n' '\set ON_ERROR_STOP on' > "$migration_driver_file"
printf '%s\n' "SELECT pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended(
    'axel:postgres:migrations:' || pg_catalog.current_database(),
    0
  )
);" >> "$migration_driver_file"

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

  already_applied="$(psql_safe -At -c "
    SELECT sha256 FROM schema_migrations WHERE filename = '$fname' LIMIT 1
  ")"

  if [ -n "$already_applied" ]; then
    # Baseline markers represent schemas adopted before content hashes were
    # recorded. Every migration applied by this runner has a real hash and is
    # immutable after release.
    if [ "$already_applied" != "legacy" ] && [ "$already_applied" != "schema-bootstrap" ]; then
      file_sha="$(migration_sha256 "$fpath")"
      if [ "$already_applied" != "$file_sha" ]; then
        echo "[run-migrations] checksum mismatch for applied migration $fname" >&2
        echo "[run-migrations] restore the released file; never edit an applied migration" >&2
        exit 1
      fi
    fi
    skipped_count=$((skipped_count + 1))
    continue
  fi

  file_sha="$(migration_sha256 "$fpath")"
  transaction_mode="$(
    node "$SCRIPT_DIR/postgres-migration-safety.mjs" --transaction-mode "$fpath"
  )"

  echo "[run-migrations] applying $fname (sha256 ${file_sha:0:12}…)"

  # A second runner may have been waiting on the advisory lock after this
  # process read the ledger. Recheck under the lock and skip work it committed.
  # A conflicting hash causes division by zero with ON_ERROR_STOP enabled.
  printf "SELECT 1 / CASE WHEN NOT EXISTS (\n" >> "$migration_driver_file"
  printf "  SELECT 1 FROM public.schema_migrations\n" >> "$migration_driver_file"
  printf "   WHERE filename = '%s'\n" "$fname" >> "$migration_driver_file"
  printf "     AND sha256 NOT IN ('legacy', 'schema-bootstrap', '%s')\n" \
    "$file_sha" >> "$migration_driver_file"
  printf ") THEN 1 ELSE 0 END;\n" >> "$migration_driver_file"
  printf "SELECT NOT EXISTS (\n" >> "$migration_driver_file"
  printf "  SELECT 1 FROM public.schema_migrations WHERE filename = '%s'\n" \
    "$fname" >> "$migration_driver_file"
  printf ") AS migration_pending \\gset\n" >> "$migration_driver_file"
  printf '%s\n' '\if :migration_pending' >> "$migration_driver_file"

  if [ "$transaction_mode" = "atomic" ]; then
    printf '%s\n' 'BEGIN;' >> "$migration_driver_file"
    printf "\\ir '%s'\n" "$fpath" >> "$migration_driver_file"
    printf "INSERT INTO public.schema_migrations (filename, sha256)\n" \
      >> "$migration_driver_file"
    printf "VALUES ('%s', '%s');\n" "$fname" "$file_sha" \
      >> "$migration_driver_file"
    printf '%s\n' 'COMMIT;' >> "$migration_driver_file"
  else
    # Validation above proved that this is an exact, hash-pinned historical
    # exception. Its DDL cannot share a transaction with the ledger record.
    printf "\\ir '%s'\n" "$fpath" >> "$migration_driver_file"
    printf '%s\n' 'BEGIN;' >> "$migration_driver_file"
    printf "INSERT INTO public.schema_migrations (filename, sha256)\n" \
      >> "$migration_driver_file"
    printf "VALUES ('%s', '%s');\n" "$fname" "$file_sha" \
      >> "$migration_driver_file"
    printf '%s\n' 'COMMIT;' >> "$migration_driver_file"
  fi
  printf '%s\n' '\endif' >> "$migration_driver_file"

  applied_count=$((applied_count + 1))
done

printf '%s\n' "SELECT pg_catalog.pg_advisory_unlock(
  pg_catalog.hashtextextended(
    'axel:postgres:migrations:' || pg_catalog.current_database(),
    0
  )
);" >> "$migration_driver_file"

if [ "$applied_count" -gt 0 ]; then
  psql_safe -v ON_ERROR_STOP=1 -q -f "$migration_driver_file" > /dev/null
fi
rm -f "$migration_driver_file"
trap - EXIT

preflight_migration_role
assert_role_state_unchanged "$initial_role_state"

echo "[run-migrations] done — applied $applied_count, skipped $skipped_count"
