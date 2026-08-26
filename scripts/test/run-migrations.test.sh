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

# Start from a disposable empty database and pin the ordinary bootstrap path.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL

first_run_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$first_run_output" | grep -q "applied 0"
second_run_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$second_run_output" | grep -q "applied 0"

# Recreate the exact adoption hazard: the application schema is at 0064, the
# migration ledger is empty, and 0065's membership FK/data cleanup is absent.
# A runner that labels every file in the checkout as legacy will skip 0065.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
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

upgrade_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$upgrade_output" | grep -q "adopting through proven baseline 0064_email_verifications.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0065_personal_access_tokens_membership.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0066_destination_credential_binding.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0067_pull_source_credential_binding.sql"
printf '%s\n' "$upgrade_output" | grep -q "applying 0068_replay_payload_workspace_binding.sql"

# The circular destination/current-credential relationship must be creatable in
# one transaction, while a reference to another destination remains rejected.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
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

assertions="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 <<'SQL'
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
SQL
)"
if [ "$assertions" != $'t\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt\nt' ]; then
  echo "migration adoption assertions failed:" >&2
  printf '%s\n' "$assertions" >&2
  exit 1
fi

idempotent_output="$("$ROOT_DIR/scripts/run-migrations.sh")"
printf '%s\n' "$idempotent_output" | grep -q "applied 0"

echo "run-migrations tests passed"
