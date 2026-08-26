-- Migration 0048: tighten retention caps (storage-cost guardrail) + honest
-- raw-payload ceiling.
--
-- Migration 0018 set every retention max to 3650 days (10y). Two problems
-- with that ceiling:
--
--   1. dead_letter / replay rows live in Postgres (≈127x the per-GB cost of
--      R2) and have NO absolute expiry — they rely solely on the per-workspace
--      knob. A workspace pinning 10y of dead-letters at 10M tasks/day is
--      hundreds of GB of the expensive store. Lower the ceilings to bound that:
--      dead_letter 365, replay 90. (audit_log is intentionally LEFT at 3650 —
--      it is the cheap, low-volume, compliance-sensitive table; capping it has
--      only downside, and a CHECK can't grandfather rows, so a lower cap would
--      forcibly shorten anyone who deliberately chose long audit retention.)
--
--   2. raw_payload_retention_days is presented in the UI as controlling "R2 raw
--      event bodies", but R2 bytes are deleted by a FIXED 30-day, bucket-wide
--      lifecycle rule (infra/cloudflare/r2-lifecycle.json) — nothing reads
--      raw_payload_retention_days for byte deletion. A value above 30 is a
--      no-op (and a misleading compliance signal). Cap it at 30 to match what
--      the platform actually delivers, and drop the default 90 -> 30 so new
--      workspaces don't advertise a lie. transient mode (= 0) stays allowed.
--
-- These CHECK bounds MUST stay in lockstep with RETENTION_BOUNDS in
-- apps/dashboard/lib/retention-bounds.ts (the form-level mirror). This
-- migration is the real backstop.
--
-- Idempotent: clamps any existing out-of-range rows DOWN to the new max BEFORE
-- swapping the constraint (a lowered max would otherwise be rejected by ADD
-- CONSTRAINT), and drops-then-re-adds CHECKs by canonical name regardless of
-- the auto-generated names 0018 gave its inline column constraints.
--
-- Wrapped in a transaction so the destructive drop-then-re-add of the CHECK
-- constraints is all-or-nothing — a mid-way failure leaves the old constraints
-- intact rather than a window with the tables unconstrained. All statements
-- here (UPDATE / ALTER ... SET DEFAULT / DROP+ADD CONSTRAINT / DO blocks) are
-- transactional in Postgres.
BEGIN;

-- 1. Clamp existing values into the new ranges (no-op on a fresh DB). Every
--    existing workspace defaults raw_payload to 90, so all of them clamp to 30.
UPDATE workspaces SET
  raw_payload_retention_days    = LEAST(raw_payload_retention_days, 30),
  dead_letter_retention_days    = LEAST(dead_letter_retention_days, 365),
  replay_request_retention_days = LEAST(replay_request_retention_days, 90)
WHERE raw_payload_retention_days > 30
   OR dead_letter_retention_days > 365
   OR replay_request_retention_days > 90;

UPDATE sources
   SET raw_payload_retention_days = LEAST(raw_payload_retention_days, 30)
 WHERE raw_payload_retention_days > 30;

-- 2. Lower the raw_payload column default so new workspaces don't default above
--    the new max. The other defaults (dead_letter 90, replay 30, audit 365) are
--    all inside their ranges already.
ALTER TABLE workspaces ALTER COLUMN raw_payload_retention_days SET DEFAULT 30;

-- 3. Swap the workspace CHECK constraints. Drop every existing CHECK on the
--    retention columns (0018's inline names are auto-generated), then re-add
--    canonically-named ones with the new bounds. audit_log is re-added with its
--    UNCHANGED 30..3650 range (it gets dropped by the match below too).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'workspaces'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%retention_days%'
  LOOP
    EXECUTE format('ALTER TABLE workspaces DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_raw_payload_retention_days_check
    CHECK (raw_payload_retention_days >= 0 AND raw_payload_retention_days <= 30),
  ADD CONSTRAINT workspaces_dead_letter_retention_days_check
    CHECK (dead_letter_retention_days >= 1 AND dead_letter_retention_days <= 365),
  ADD CONSTRAINT workspaces_replay_request_retention_days_check
    CHECK (replay_request_retention_days >= 1 AND replay_request_retention_days <= 90),
  ADD CONSTRAINT workspaces_audit_log_retention_days_check
    CHECK (audit_log_retention_days >= 30 AND audit_log_retention_days <= 3650);

-- 4. Same for the per-source raw_payload override (NULL = inherit workspace).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'sources'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%raw_payload_retention_days%'
  LOOP
    EXECUTE format('ALTER TABLE sources DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE sources
  ADD CONSTRAINT sources_raw_payload_retention_days_check
    CHECK (raw_payload_retention_days IS NULL
           OR (raw_payload_retention_days >= 0 AND raw_payload_retention_days <= 30));

COMMIT;
