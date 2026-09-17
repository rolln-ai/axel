-- Migration 0079: marker for the dead-letter triage capability grant.
--
-- The delivery-workers profile gained UPDATE on dead_letters and SELECT on
-- dead_letter_mutes for Jev triage (migration 0078, PR #101). Existing
-- installs receive those grants from scripts/sync-dead-letter-triage-access.sql,
-- which run-migrations.sh applies after the migrations. The owner preflight
-- tolerates the missing grants only while this file is absent from the
-- ledger, so the reviewed sync can land in the same run. Runtime verification
-- stays strict throughout.
COMMENT ON COLUMN public.dead_letters.triage_reason IS
  'Jev typed failure reason. Workers grant: scripts/sync-dead-letter-triage-access.sql';
