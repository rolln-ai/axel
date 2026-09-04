#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must point at a disposable Postgres test database" >&2
  exit 1
fi
if [ "${AXEL_MIGRATION_TEST_ALLOW_RESET:-}" != "1" ]; then
  echo "refusing to reset the test database without AXEL_MIGRATION_TEST_ALLOW_RESET=1" >&2
  exit 1
fi
if [[ ! "${DATABASE_MIGRATION_ROLE:-}" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "DATABASE_MIGRATION_ROLE must name the disposable database owner" >&2
  exit 1
fi
if [[ ! "${DATABASE_MIGRATION_LOGIN_ROLE:-}" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "DATABASE_MIGRATION_LOGIN_ROLE must name the disposable migration login" >&2
  exit 1
fi
if [ "$DATABASE_MIGRATION_ROLE" = "$DATABASE_MIGRATION_LOGIN_ROLE" ]; then
  echo "the disposable migration owner and login must be distinct" >&2
  exit 1
fi
if [[ ! "${DATABASE_VERIFY_CAPABILITY_ROLE:-}" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "DATABASE_VERIFY_CAPABILITY_ROLE must name the disposable verify capability role" >&2
  exit 1
fi
if [[ ! "${DATABASE_RUNTIME_CAPABILITY_ROLES:-}" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "DATABASE_RUNTIME_CAPABILITY_ROLES must name one disposable runtime capability role" >&2
  exit 1
fi
if [ "$DATABASE_VERIFY_CAPABILITY_ROLE" = "$DATABASE_MIGRATION_ROLE" ] \
  || [ "$DATABASE_VERIFY_CAPABILITY_ROLE" = "$DATABASE_MIGRATION_LOGIN_ROLE" ] \
  || [ "$DATABASE_RUNTIME_CAPABILITY_ROLES" = "$DATABASE_MIGRATION_ROLE" ] \
  || [ "$DATABASE_RUNTIME_CAPABILITY_ROLES" = "$DATABASE_MIGRATION_LOGIN_ROLE" ] \
  || [ "$DATABASE_RUNTIME_CAPABILITY_ROLES" = "$DATABASE_VERIFY_CAPABILITY_ROLE" ]; then
  echo "the disposable migration and capability roles must be distinct" >&2
  exit 1
fi
export DATABASE_MIGRATION_ROLE_REQUIRED=1

migration_psql() {
  node "$ROOT_DIR/scripts/psql-safe.mjs" "$@"
}

runner_failure_class() {
  local status="$1"
  local output_path="$2"
  if [ "$status" -eq 0 ]; then
    printf '%s' "ok"
  elif grep -Fq "migration role or public schema is not safely sealed" "$output_path"; then
    printf '%s' "role_preflight"
  elif grep -Fq "migration changed role attributes or memberships" "$output_path"; then
    printf '%s' "role_state_changed"
  elif grep -Fq "psql_safe_connection_failed" "$output_path"; then
    printf '%s' "database_connection"
  elif grep -Fq "psql_safe_command_failed" "$output_path"; then
    printf '%s' "database_command"
  elif grep -Fq "checksum mismatch for applied migration" "$output_path"; then
    printf '%s' "checksum_mismatch"
  elif grep -Fq "duplicate migration number used by" "$output_path" \
    || grep -Fq "migration names must match" "$output_path" \
    || grep -Fq "schema.sql is not in parity" "$output_path"; then
    printf '%s' "migration_validation"
  else
    printf '%s' "unknown"
  fi
}

if [ -n "${DATABASE_ADMIN_URL:-}" ]; then
  if [ -z "${DATABASE_MIGRATION_TEST_PASSWORD:-}" ]; then
    echo "DATABASE_MIGRATION_TEST_PASSWORD is required with DATABASE_ADMIN_URL" >&2
    exit 1
  fi
  psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -q \
    -v owner_role="$DATABASE_MIGRATION_ROLE" \
    -v login_role="$DATABASE_MIGRATION_LOGIN_ROLE" \
    -v login_password="$DATABASE_MIGRATION_TEST_PASSWORD" \
    -v verify_role="$DATABASE_VERIFY_CAPABILITY_ROLE" \
    -v runtime_capability_role="$DATABASE_RUNTIME_CAPABILITY_ROLES" <<'SQL'
SELECT pg_catalog.format(
  'CREATE ROLE %I NOLOGIN NOINHERIT CREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS',
  :'owner_role'
) WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'owner_role'
) \gexec
SELECT pg_catalog.format(
  'ALTER ROLE %I NOLOGIN NOINHERIT CREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS',
  :'owner_role'
) \gexec
SELECT pg_catalog.format(
  'CREATE ROLE %I LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'login_role', :'login_password'
) WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'login_role'
) \gexec
SELECT pg_catalog.format(
  'ALTER ROLE %I LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'login_role', :'login_password'
) \gexec
SELECT pg_catalog.format(
  'CREATE ROLE %I NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS',
  :'verify_role'
) WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'verify_role'
) \gexec
SELECT pg_catalog.format(
  'ALTER ROLE %I NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS',
  :'verify_role'
) \gexec
SELECT pg_catalog.format('ALTER ROLE %I RESET ALL', :'verify_role') \gexec
SELECT pg_catalog.format(
  'CREATE ROLE %I NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS',
  :'runtime_capability_role'
) WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'runtime_capability_role'
) \gexec
SELECT pg_catalog.format(
  'ALTER ROLE %I NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS',
  :'runtime_capability_role'
) \gexec
SELECT pg_catalog.format('ALTER ROLE %I RESET ALL', :'runtime_capability_role') \gexec
SELECT pg_catalog.format('REVOKE %I FROM %I', :'owner_role', :'login_role') \gexec
SELECT pg_catalog.format(
  'GRANT %I TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
  :'owner_role', :'login_role'
) \gexec
SELECT pg_catalog.format(
  'ALTER DATABASE %I OWNER TO %I',
  pg_catalog.current_database(), :'owner_role'
) \gexec
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC',
  pg_catalog.current_database()
) \gexec
SELECT pg_catalog.format(
  'GRANT CONNECT ON DATABASE %I TO %I',
  pg_catalog.current_database(), :'login_role'
) \gexec
DROP SCHEMA public CASCADE;
SELECT pg_catalog.format('CREATE SCHEMA public AUTHORIZATION %I', :'owner_role') \gexec
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
SQL

  psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -q \
    -v login_role="$DATABASE_MIGRATION_LOGIN_ROLE" <<'SQL'
SELECT pg_catalog.format('ALTER ROLE %I SUPERUSER', :'login_role') \gexec
SQL
  if "$ROOT_DIR/scripts/run-migrations.sh" >/dev/null 2>&1; then
    echo "migration runner accepted a disguised superuser session login" >&2
    exit 1
  fi
  psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -q \
    -v login_role="$DATABASE_MIGRATION_LOGIN_ROLE" <<'SQL'
SELECT pg_catalog.format('ALTER ROLE %I NOSUPERUSER', :'login_role') \gexec
SQL

  if DATABASE_MIGRATION_OWNER_PARENT_ROLES='parent_role,parent_role' \
    "$ROOT_DIR/scripts/run-migrations.sh" >/dev/null 2>&1; then
    echo "migration runner accepted duplicate owner parent roles" >&2
    exit 1
  fi

  psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -q \
    -v owner_role="$DATABASE_MIGRATION_ROLE" <<'SQL'
SELECT 'CREATE ROLE axel_migration_test_rogue_parent NOLOGIN SUPERUSER'
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'axel_migration_test_rogue_parent'
 ) \gexec
ALTER ROLE axel_migration_test_rogue_parent NOLOGIN SUPERUSER;
SELECT pg_catalog.format(
  'GRANT axel_migration_test_rogue_parent TO %I WITH ADMIN OPTION',
  :'owner_role'
) \gexec
SQL
  if "$ROOT_DIR/scripts/run-migrations.sh" >/dev/null 2>&1; then
    echo "migration runner accepted an unexpected powerful owner parent" >&2
    exit 1
  fi
  psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -q \
    -v owner_role="$DATABASE_MIGRATION_ROLE" <<'SQL'
SELECT pg_catalog.format(
  'REVOKE axel_migration_test_rogue_parent FROM %I',
  :'owner_role'
) \gexec
DROP ROLE axel_migration_test_rogue_parent;
SQL

  psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -q \
    -v runtime_capability_role="$DATABASE_RUNTIME_CAPABILITY_ROLES" <<'SQL'
SELECT pg_catalog.format('ALTER ROLE %I SUPERUSER', :'runtime_capability_role') \gexec
SQL
  if "$ROOT_DIR/scripts/run-migrations.sh" >/dev/null 2>&1; then
    echo "migration runner accepted unsafe runtime capability attributes" >&2
    exit 1
  fi
  psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -q \
    -v runtime_capability_role="$DATABASE_RUNTIME_CAPABILITY_ROLES" <<'SQL'
SELECT pg_catalog.format(
  'ALTER ROLE %I NOSUPERUSER NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS',
  :'runtime_capability_role'
) \gexec
SELECT pg_catalog.format('ALTER ROLE %I RESET ALL', :'runtime_capability_role') \gexec
SQL
fi

# Start from a disposable empty database and pin the ordinary bootstrap path.
migration_psql -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION CURRENT_USER;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
SQL

# A partial target is not fresh. The runner must stop before creating even its
# ledger, leaving operator recovery unambiguous.
migration_psql -v ON_ERROR_STOP=1 -q -c "CREATE TABLE public.partial_probe(id integer)"
if "$ROOT_DIR/scripts/run-migrations.sh" >/dev/null 2>&1; then
  echo "migration runner bootstrapped a non-empty partial target" >&2
  exit 1
fi
partial_state="$(migration_psql -At -v ON_ERROR_STOP=1 -c "
  SELECT pg_catalog.to_regclass('public.schema_migrations') IS NULL
")"
if [ "$partial_state" != "t" ]; then
  echo "partial-target refusal mutated the database" >&2
  exit 1
fi
migration_psql -v ON_ERROR_STOP=1 -q -c "DROP TABLE public.partial_probe"

# The exact multi-file, single-transaction primitive used for bootstrap must
# roll back the ledger and full snapshot together on a late failure.
if node "$ROOT_DIR/scripts/psql-safe.mjs" -v ON_ERROR_STOP=1 -q -1 \
  -f "$ROOT_DIR/scripts/ensure-database-migration-ledger.sql" \
  -f "$ROOT_DIR/infra/postgres/schema.sql" \
  -c "SELECT 1 / 0" >/dev/null 2>&1; then
  echo "atomic bootstrap accepted an injected late failure" >&2
  exit 1
fi
atomic_state="$(migration_psql -At -v ON_ERROR_STOP=1 -c "
  SELECT pg_catalog.to_regclass('public.schema_migrations') IS NULL
     AND pg_catalog.to_regclass('public.workspaces') IS NULL
")"
if [ "$atomic_state" != "t" ]; then
  echo "failed atomic bootstrap left partial schema state" >&2
  exit 1
fi

first_run_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$first_run_output" | grep -q "applied 0"
second_run_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$second_run_output" | grep -q "applied 0"

migration_psql -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.billing_events (id, type, payload)
VALUES ('billing_guard_bootstrap_probe', 'test.bootstrap',
        pg_catalog.jsonb_build_object('unexpected', true));
UPDATE public.billing_events
   SET payload = pg_catalog.jsonb_build_object('unexpected', true)
 WHERE id = 'billing_guard_bootstrap_probe';
SQL

expected_baseline_count="$(find "$ROOT_DIR/infra/postgres/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')"
bootstrap_assertions="$(migration_psql -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) = 5
  FROM pg_constraint
 WHERE conname IN (
   'workspaces_raw_payload_retention_days_check',
   'workspaces_dead_letter_retention_days_check',
   'workspaces_replay_request_retention_days_check',
   'workspaces_audit_log_retention_days_check',
   'sources_raw_payload_retention_days_check'
 );
SELECT indisunique
  FROM pg_index
 WHERE indexrelid = 'erasure_subjects_ws_subject_event_uniq'::regclass;
SELECT to_regclass('public.erasure_subjects_lookup_idx') IS NULL;
SELECT count(*) = 3
  FROM pg_trigger
 WHERE tgname IN (
   'data_contract_versions_privacy_guard',
   'data_contract_fixtures_privacy_guard',
   'data_contract_drift_events_privacy_guard'
 )
   AND NOT tgisinternal;
SELECT count(*) = 1
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'routes'
   AND column_name = 'name';
SELECT to_regclass('public.workspaces_deleting_idx') IS NOT NULL;
SELECT to_regclass('public.dead_letters_errored_at_idx') IS NOT NULL;
SELECT to_regclass('public.audit_log_at_idx') IS NOT NULL;
SELECT count(*) = 1
  FROM pg_catalog.pg_trigger
 WHERE tgname = 'billing_events_payload_minimization_guard'
   AND tgrelid = 'public.billing_events'::pg_catalog.regclass
   AND NOT tgisinternal;
SELECT NOT routine.prosecdef
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               routine.proacl,
               pg_catalog.acldefault('f', routine.proowner)
             )
           ) AS privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
       )
  FROM pg_catalog.pg_proc routine
  JOIN pg_catalog.pg_namespace namespace
    ON namespace.oid = routine.pronamespace
 WHERE namespace.nspname = 'public'
   AND routine.proname = 'axel_minimize_billing_event_payload'
   AND routine.pronargs = 0;
SELECT payload = '{}'::pg_catalog.jsonb
  FROM public.billing_events
 WHERE id = 'billing_guard_bootstrap_probe';
SELECT count(*) FROM schema_migrations WHERE sha256 = 'schema-bootstrap';
SQL
)"
if [ "$bootstrap_assertions" != $'t\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\n'"$expected_baseline_count" ]; then
  echo "fresh schema baseline parity assertions failed" >&2
  exit 1
fi

# Migration 0062 drops and recreates a generated billing column. Re-run that
# shape from a copied checkout with a failure injected between the two
# statements. The runner must roll back the drop and omit the ledger record.
atomic_runner_root="$(mktemp -d)"
atomic_runner_output="$(mktemp)"
atomic_second_output="$(mktemp)"
trap 'rm -rf "$atomic_runner_root"; rm -f "$atomic_runner_output" "$atomic_second_output"' EXIT
cp -R "$ROOT_DIR/scripts" "$atomic_runner_root/scripts"
mkdir -p "$atomic_runner_root/infra"
cp -R "$ROOT_DIR/infra/postgres" "$atomic_runner_root/infra/postgres"
awk '
  { print }
  /DROP COLUMN total_tasks;/ { print "SELECT 1 / 0;" }
' "$ROOT_DIR/infra/postgres/migrations/0062_inbound_only_billing.sql" \
  > "$atomic_runner_root/infra/postgres/migrations/0062_inbound_only_billing.sql.tmp"
mv "$atomic_runner_root/infra/postgres/migrations/0062_inbound_only_billing.sql.tmp" \
  "$atomic_runner_root/infra/postgres/migrations/0062_inbound_only_billing.sql"
grep -q 'SELECT 1 / 0;' \
  "$atomic_runner_root/infra/postgres/migrations/0062_inbound_only_billing.sql"

migration_psql -v ON_ERROR_STOP=1 -q -c "
  DELETE FROM public.schema_migrations
   WHERE filename >= '0062_inbound_only_billing.sql'
"
if "$atomic_runner_root/scripts/run-migrations.sh" \
  >"$atomic_runner_output" 2>&1; then
  echo "migration runner committed a migration with a late statement failure" >&2
  exit 1
fi
grep -q "applying 0062_inbound_only_billing.sql" "$atomic_runner_output"
grep -q "psql_safe_command_failed" "$atomic_runner_output"
atomic_0062_state="$(migration_psql -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) = 1
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'workspace_usage_period'
   AND column_name = 'total_tasks'
   AND is_generated = 'ALWAYS';
SELECT count(*) = 0
  FROM public.schema_migrations
 WHERE filename = '0062_inbound_only_billing.sql';
SQL
)"
if [ "$atomic_0062_state" != $'t\nt' ]; then
  echo "failed 0062-style migration left partial schema or ledger state" >&2
  exit 1
fi

atomic_recovery_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$atomic_recovery_output" \
  | grep -q "applying 0062_inbound_only_billing.sql"
atomic_recovery_state="$(migration_psql -At -v ON_ERROR_STOP=1 -c "
  SELECT sha256 ~ '^[0-9a-f]{64}$'
    FROM public.schema_migrations
   WHERE filename = '0062_inbound_only_billing.sql'
")"
if [ "$atomic_recovery_state" != "t" ]; then
  echo "0062-style migration recovery did not record its checksum" >&2
  exit 1
fi

# Two runners can both observe a pending file before either acquires the lock.
# The first holds the advisory lock while this non-idempotent fixture sleeps;
# the second must recheck the ledger under that lock and skip the fixture.
cp "$ROOT_DIR/infra/postgres/migrations/0062_inbound_only_billing.sql" \
  "$atomic_runner_root/infra/postgres/migrations/0062_inbound_only_billing.sql"
latest_migration_number="$(
  find "$ROOT_DIR/infra/postgres/migrations" -maxdepth 1 -type f -name '*.sql' \
    -exec basename {} \; | cut -c1-4 | sort -n | tail -1
)"
if [[ ! "$latest_migration_number" =~ ^[0-9]{4}$ ]]; then
  echo "could not derive synthetic migration fixture numbers" >&2
  exit 1
fi
printf -v advisory_migration_number '%04d' "$((10#$latest_migration_number + 1))"
printf -v future_transaction_number '%04d' "$((10#$latest_migration_number + 2))"
advisory_migration_name="${advisory_migration_number}_advisory_lock_probe.sql"
future_transaction_name="${future_transaction_number}_future_explicit_transaction.sql"
printf '%s\n' \
  'SELECT pg_catalog.pg_sleep(3);' \
  'CREATE TABLE public.migration_advisory_lock_probe (id integer PRIMARY KEY);' \
  'INSERT INTO public.migration_advisory_lock_probe (id) VALUES (1);' \
  > "$atomic_runner_root/infra/postgres/migrations/$advisory_migration_name"

"$atomic_runner_root/scripts/run-migrations.sh" \
  >"$atomic_runner_output" 2>&1 &
first_runner_pid=$!
"$atomic_runner_root/scripts/run-migrations.sh" \
  >"$atomic_second_output" 2>&1 &
second_runner_pid=$!
first_runner_status=0
second_runner_status=0
wait "$first_runner_pid" || first_runner_status=$?
wait "$second_runner_pid" || second_runner_status=$?
if [ "$first_runner_status" -ne 0 ] || [ "$second_runner_status" -ne 0 ]; then
  first_runner_class="$(runner_failure_class "$first_runner_status" "$atomic_runner_output")"
  second_runner_class="$(runner_failure_class "$second_runner_status" "$atomic_second_output")"
  echo "concurrent migration runners did not serialize cleanly: $first_runner_class/$second_runner_class" >&2
  exit 1
fi
advisory_lock_state="$(migration_psql -At -v ON_ERROR_STOP=1 \
  -v advisory_migration_name="$advisory_migration_name" <<'SQL'
SELECT count(*) = 1 FROM public.migration_advisory_lock_probe;
SELECT count(*) = 1
  FROM public.schema_migrations
 WHERE filename = :'advisory_migration_name';
SQL
)"
if [ "$advisory_lock_state" != $'t\nt' ]; then
  echo "advisory lock test applied a migration more than once" >&2
  exit 1
fi
migration_psql -v ON_ERROR_STOP=1 -q \
  -v advisory_migration_name="$advisory_migration_name" <<'SQL'
DROP TABLE public.migration_advisory_lock_probe;
DELETE FROM public.schema_migrations
 WHERE filename = :'advisory_migration_name';
SQL
printf '%s\n' \
  'BEGIN;' \
  'CREATE TABLE public.future_explicit_transaction_probe (id integer);' \
  'COMMIT;' \
  > "$atomic_runner_root/infra/postgres/migrations/$future_transaction_name"
if "$atomic_runner_root/scripts/run-migrations.sh" \
  >"$atomic_runner_output" 2>&1; then
  echo "migration runner accepted new explicit transaction control" >&2
  exit 1
fi
grep -q "$future_transaction_name cannot use the required atomic migration wrapper" \
  "$atomic_runner_output"
future_transaction_state="$(migration_psql -At -v ON_ERROR_STOP=1 \
  -v advisory_migration_name="$advisory_migration_name" \
  -v future_transaction_name="$future_transaction_name" <<'SQL'
SELECT pg_catalog.to_regclass('public.future_explicit_transaction_probe') IS NULL;
SELECT count(*) = 0
  FROM public.schema_migrations
  WHERE filename IN (
    :'advisory_migration_name',
    :'future_transaction_name'
  );
SQL
)"
if [ "$future_transaction_state" != $'t\nt' ]; then
  echo "future transaction-mode refusal changed database state" >&2
  exit 1
fi
rm -rf "$atomic_runner_root"
rm -f "$atomic_runner_output" "$atomic_second_output"
trap - EXIT

# Recreate the old adoption hazard: the application schema is at 0064, the
# migration ledger is empty, and 0065's membership cleanup is absent. The
# runner must now refuse rather than inferring history from a few object names.
migration_psql -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE personal_access_tokens
  DROP CONSTRAINT personal_access_tokens_membership_fkey;
ALTER TABLE destinations
  DROP CONSTRAINT destinations_credentials_binding_fkey;
DROP INDEX destination_credentials_binding_idx;
ALTER TABLE pull_sources
  DROP CONSTRAINT pull_sources_credentials_binding_fkey;
DROP INDEX pull_source_credentials_binding_idx;
ALTER TABLE replay_requests
  DROP CONSTRAINT replay_requests_workspace_r2_key_check;
ALTER TABLE dead_letters
  DROP COLUMN is_test;
DROP TRIGGER billing_events_payload_minimization_guard
  ON billing_events;
DROP FUNCTION axel_minimize_billing_event_payload();
DELETE FROM billing_events
 WHERE id = 'billing_guard_bootstrap_probe';
TRUNCATE schema_migrations;

INSERT INTO workspaces (id, name) VALUES ('ws_migration_adoption', 'Migration adoption');
INSERT INTO workspaces (id, name) VALUES ('ws_migration_other', 'Migration other');
INSERT INTO users (id, email, name, password_hash)
VALUES ('usr_migration_orphan', 'migration-orphan@example.test', 'Migration orphan', 'not-a-real-password-hash');
INSERT INTO personal_access_tokens (id, workspace_id, user_id, token_hash, name)
VALUES ('pat_migration_orphan', 'ws_migration_adoption', 'usr_migration_orphan', 'migration-orphan-hash', 'orphan');
INSERT INTO replay_requests
  (id, workspace_id, event_id, source_id, r2_key, scope, state)
VALUES
  ('rpy_migration_foreign', 'ws_migration_adoption', 'evt_foreign', 'src_local',
   'events/ws_migration_other/2026-08-26/evt_foreign', 'all', 'pending');
INSERT INTO billing_events (id, type, workspace_id, payload)
VALUES ('billing_guard_adoption_probe', 'test.adoption',
        'ws_migration_adoption', pg_catalog.jsonb_build_object('unexpected', true));

INSERT INTO destinations (id, workspace_id, name, type, config)
VALUES ('dst_migration_other', 'ws_migration_other', 'Other destination', 'http', '{}'::jsonb);
INSERT INTO destination_credentials
  (id, destination_id, workspace_id, ciphertext, nonce, auth_tag,
   fingerprint_last4, fingerprint_sha256_prefix, encryption_version)
VALUES
  ('cred_migration_other', 'dst_migration_other', 'ws_migration_other',
   decode('00', 'hex'), decode('000000000000000000000000', 'hex'),
   decode('00000000000000000000000000000000', 'hex'), '0000', '000000000000', 2);
INSERT INTO destinations (id, workspace_id, name, type, config, credentials_ref)
VALUES
  ('dst_migration_misbound', 'ws_migration_adoption', 'Misbound destination',
   'http', '{}'::jsonb, 'cred_migration_other');

INSERT INTO pull_sources (id, workspace_id, name, type, config)
VALUES ('pull_migration_other', 'ws_migration_other', 'Other pull source', 'stripe', '{}'::jsonb);
INSERT INTO pull_source_credentials
  (id, pull_source_id, workspace_id, ciphertext, nonce, auth_tag,
   fingerprint_last4, fingerprint_sha256_prefix, encryption_version)
VALUES
  ('pull_cred_migration_other', 'pull_migration_other', 'ws_migration_other',
   decode('00', 'hex'), decode('000000000000000000000000', 'hex'),
   decode('00000000000000000000000000000000', 'hex'), '0000', '000000000000', 2);
INSERT INTO pull_sources (id, workspace_id, name, type, config, credentials_ref)
VALUES
  ('pull_migration_misbound', 'ws_migration_adoption', 'Misbound pull source',
   'stripe', '{}'::jsonb, 'pull_cred_migration_other');
SQL

if empty_ledger_output="$("$ROOT_DIR/scripts/run-migrations.sh" 2>&1)"; then
  echo "migration runner adopted a non-empty database with an empty ledger" >&2
  exit 1
fi
printf '%s\n' "$empty_ledger_output" \
  | grep -q "refusing a non-empty database with an empty migration ledger"
empty_ledger_count="$(migration_psql -At -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM public.schema_migrations")"
if [ "$empty_ledger_count" != "0" ]; then
  echo "empty-ledger refusal wrote migration markers" >&2
  exit 1
fi

migration_psql -v ON_ERROR_STOP=1 -q -c "
  INSERT INTO public.schema_migrations (filename, sha256)
  VALUES ('9999_fake.sql', 'legacy')
"
if unknown_ledger_output="$("$ROOT_DIR/scripts/run-migrations.sh" 2>&1)"; then
  echo "migration runner accepted an unknown high ledger filename" >&2
  exit 1
fi
printf '%s\n' "$unknown_ledger_output" \
  | grep -q "migration ledger contains an unknown filename"
migration_psql -v ON_ERROR_STOP=1 -q \
  -c "DELETE FROM public.schema_migrations WHERE filename = '9999_fake.sql'"

migration_psql -v ON_ERROR_STOP=1 -q -c "
  INSERT INTO public.schema_migrations (filename, sha256)
  VALUES ('0002_workspace_timezone.sql', 'legacy')
"
if sparse_ledger_output="$("$ROOT_DIR/scripts/run-migrations.sh" 2>&1)"; then
  echo "migration runner accepted a sparse historical ledger" >&2
  exit 1
fi
printf '%s\n' "$sparse_ledger_output" \
  | grep -q "migration ledger is not an exact contiguous repository prefix"
migration_psql -v ON_ERROR_STOP=1 -q \
  -c "DELETE FROM public.schema_migrations WHERE filename = '0002_workspace_timezone.sql'"

# A reviewed recovery restores the exact historical ledger. The runner can
# then apply only the genuinely pending migrations.
legacy_registration_file="$(mktemp)"
chmod 600 "$legacy_registration_file"
trap 'rm -f "$legacy_registration_file"' EXIT
for fpath in $(find "$ROOT_DIR/infra/postgres/migrations" -maxdepth 1 -type f -name '*.sql' | sort); do
  fname="$(basename "$fpath")"
  if [[ "$fname" > "0064_email_verifications.sql" ]]; then
    continue
  fi
  printf "INSERT INTO public.schema_migrations (filename, sha256) VALUES ('%s', 'legacy');\n" \
    "$fname" >> "$legacy_registration_file"
done
migration_psql -v ON_ERROR_STOP=1 -q -1 -f "$legacy_registration_file"
rm -f "$legacy_registration_file"
trap - EXIT

upgrade_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$upgrade_output" | grep -q "ledger watermark 0064_email_verifications.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0065_personal_access_tokens_membership.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0066_destination_credential_binding.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0067_pull_source_credential_binding.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0068_replay_payload_workspace_binding.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0071_dead_letters_is_test.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0074_billing_events_payload_minimization.sql"

# Reapplying the SQL after the ledger-backed application must be harmless. An
# old writer that still supplies payload data must also remain compatible.
migration_psql -v ON_ERROR_STOP=1 -q \
  -f "$ROOT_DIR/infra/postgres/migrations/0074_billing_events_payload_minimization.sql"
migration_psql -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO billing_events (id, type, workspace_id, payload)
VALUES ('billing_guard_rolling_writer_probe', 'test.rolling_writer',
        'ws_migration_adoption', pg_catalog.jsonb_build_object('unexpected', true));
UPDATE billing_events
   SET payload = pg_catalog.jsonb_build_object('unexpected', true)
 WHERE id = 'billing_guard_rolling_writer_probe';
SQL

# The circular destination/current-credential relationship must be creatable in
# one transaction, while a reference to another destination remains rejected.
migration_psql -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
INSERT INTO destinations (id, workspace_id, name, type, config, credentials_ref)
VALUES ('dst_migration_valid', 'ws_migration_adoption', 'Valid destination',
        'http', '{}'::jsonb, 'cred_migration_valid');
INSERT INTO destination_credentials
  (id, destination_id, workspace_id, ciphertext, nonce, auth_tag,
   fingerprint_last4, fingerprint_sha256_prefix, encryption_version)
VALUES
  ('cred_migration_valid', 'dst_migration_valid', 'ws_migration_adoption',
   decode('00', 'hex'), decode('000000000000000000000000', 'hex'),
   decode('00000000000000000000000000000000', 'hex'), '0000', '000000000000', 2);
COMMIT;

BEGIN;
INSERT INTO pull_sources (id, workspace_id, name, type, config, credentials_ref)
VALUES ('pull_migration_valid', 'ws_migration_adoption', 'Valid pull source',
        'stripe', '{}'::jsonb, 'pull_cred_migration_valid');
INSERT INTO pull_source_credentials
  (id, pull_source_id, workspace_id, ciphertext, nonce, auth_tag,
   fingerprint_last4, fingerprint_sha256_prefix, encryption_version)
VALUES
  ('pull_cred_migration_valid', 'pull_migration_valid', 'ws_migration_adoption',
   decode('00', 'hex'), decode('000000000000000000000000', 'hex'),
   decode('00000000000000000000000000000000', 'hex'), '0000', '000000000000', 2);
COMMIT;

DO $$
BEGIN
  BEGIN
    UPDATE destinations
       SET credentials_ref = 'cred_migration_other'
     WHERE id = 'dst_migration_valid';
    SET CONSTRAINTS destinations_credentials_binding_fkey IMMEDIATE;
    RAISE EXCEPTION 'destination credential binding accepted a mismatched row';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    UPDATE pull_sources
       SET credentials_ref = 'pull_cred_migration_other'
     WHERE id = 'pull_migration_valid';
    SET CONSTRAINTS pull_sources_credentials_binding_fkey IMMEDIATE;
    RAISE EXCEPTION 'pull source credential binding accepted a mismatched row';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO replay_requests
      (id, workspace_id, event_id, source_id, r2_key, scope, state)
    VALUES
      ('rpy_migration_rejected', 'ws_migration_adoption', 'evt_rejected', 'src_local',
       'events/ws_migration_other/2026-08-26/evt_rejected', 'all', 'pending');
    RAISE EXCEPTION 'replay payload binding accepted a foreign workspace key';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;
SQL

assertions="$(migration_psql -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) = 0
  FROM personal_access_tokens
 WHERE id = 'pat_migration_orphan';
SELECT count(*) = 1
  FROM pg_constraint
 WHERE conrelid = 'personal_access_tokens'::regclass
   AND conname = 'personal_access_tokens_membership_fkey';
SELECT sha256 ~ '^[0-9a-f]{64}$'
  FROM schema_migrations
 WHERE filename = '0065_personal_access_tokens_membership.sql';
SELECT sha256 = 'legacy'
  FROM schema_migrations
 WHERE filename = '0064_email_verifications.sql';
SELECT credentials_ref IS NULL
  FROM destinations
 WHERE id = 'dst_migration_misbound';
SELECT count(*) = 1
  FROM pg_constraint
 WHERE conrelid = 'destinations'::regclass
   AND conname = 'destinations_credentials_binding_fkey'
   AND condeferrable
   AND condeferred;
SELECT sha256 ~ '^[0-9a-f]{64}$'
  FROM schema_migrations
 WHERE filename = '0066_destination_credential_binding.sql';
SELECT credentials_ref IS NULL
  FROM pull_sources
 WHERE id = 'pull_migration_misbound';
SELECT count(*) = 1
  FROM pg_constraint
 WHERE conrelid = 'pull_sources'::regclass
   AND conname = 'pull_sources_credentials_binding_fkey'
   AND condeferrable
   AND condeferred;
SELECT sha256 ~ '^[0-9a-f]{64}$'
  FROM schema_migrations
 WHERE filename = '0067_pull_source_credential_binding.sql';
SELECT state = 'failed' AND error_message = 'replay_payload_workspace_mismatch'
  FROM replay_requests
 WHERE id = 'rpy_migration_foreign';
SELECT count(*) = 1
  FROM pg_constraint
 WHERE conrelid = 'replay_requests'::regclass
   AND conname = 'replay_requests_workspace_r2_key_check'
   AND convalidated;
SELECT sha256 ~ '^[0-9a-f]{64}$'
  FROM schema_migrations
 WHERE filename = '0068_replay_payload_workspace_binding.sql';
SELECT is_nullable = 'NO' AND column_default = 'false'
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'dead_letters'
   AND column_name = 'is_test';
SELECT sha256 ~ '^[0-9a-f]{64}$'
  FROM schema_migrations
 WHERE filename = '0071_dead_letters_is_test.sql';
SELECT payload = '{}'::pg_catalog.jsonb
  FROM billing_events
 WHERE id = 'billing_guard_adoption_probe';
SELECT payload = '{}'::pg_catalog.jsonb
  FROM billing_events
 WHERE id = 'billing_guard_rolling_writer_probe';
SELECT count(*) = 1
  FROM pg_catalog.pg_trigger
 WHERE tgname = 'billing_events_payload_minimization_guard'
   AND tgrelid = 'billing_events'::pg_catalog.regclass
   AND NOT tgisinternal;
SELECT NOT routine.prosecdef
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               routine.proacl,
               pg_catalog.acldefault('f', routine.proowner)
             )
           ) AS privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
       )
  FROM pg_catalog.pg_proc routine
  JOIN pg_catalog.pg_namespace namespace
    ON namespace.oid = routine.pronamespace
 WHERE namespace.nspname = 'public'
   AND routine.proname = 'axel_minimize_billing_event_payload'
   AND routine.pronargs = 0;
SELECT sha256 ~ '^[0-9a-f]{64}$'
  FROM schema_migrations
 WHERE filename = '0074_billing_events_payload_minimization.sql';
SQL
)"
if [ "$assertions" != $'t\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt' ]; then
  echo "migration adoption assertions failed:" >&2
  printf '%s\n' "$assertions" >&2
  exit 1
fi

idempotent_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$idempotent_output" | grep -q "applied 0"

# Once the runner records a real checksum, changing that migration must stop a
# deploy rather than silently replacing the ledger hash.
migration_psql -v ON_ERROR_STOP=1 -q -c "
  UPDATE schema_migrations
     SET sha256 = repeat('0', 64)
   WHERE filename = '0071_dead_letters_is_test.sql';
"
if checksum_output="$("$ROOT_DIR/scripts/run-migrations.sh" 2>&1)"; then
  echo "migration runner accepted an applied checksum mismatch" >&2
  exit 1
fi
printf '%s\n' "$checksum_output" | grep -q "checksum mismatch for applied migration 0071_dead_letters_is_test.sql"

echo "run-migrations tests passed"
