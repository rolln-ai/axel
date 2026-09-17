-- Migration 0078: Jev dead-letter triage.
--
-- delivery-service asks TypeSafe AI's Jev for a typed failure reason on each
-- new unresolved dead letter and stores the answer here. Transient failures
-- Jev is sure about are replayed automatically; the replay id is recorded so
-- one dead letter is never auto-replayed twice. Everything else stays in the
-- inbox for a person, now with a label.
--
-- Columns are nullable so nothing changes when TYPESAFE_API_KEY is unset.

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS triage_reason text,
  ADD COLUMN IF NOT EXISTS triage_confidence double precision,
  ADD COLUMN IF NOT EXISTS triaged_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_replay_id text;

-- The worker's scan: newest untriaged, unresolved rows first.
CREATE INDEX IF NOT EXISTS dead_letters_untriaged_idx
  ON dead_letters (errored_at DESC)
  WHERE resolved_at IS NULL AND triaged_at IS NULL;
