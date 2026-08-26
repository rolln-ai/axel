-- Migration 0047: GDPR erasure request audit trail (Phase 1 foundation).
--
-- One row per per-subject erasure request. Records what was searched, what was
-- found, what was erased per store, and — load-bearing for legal honesty —
-- what could NOT be found or confirmed deleted. `coverage` distinguishes a
-- full-within-the-index-window erasure from a `partial` one (pre-feature
-- window, non-JSON events, out-of-scope tables). `deletion_manifest_hash` is a
-- hash over the (event_id, r2_key) set actually deleted, so we can later prove
-- WHAT was erased without retaining the plaintext PII.
--
-- subject_ids holds hashed locators, never raw PII. The audit row OUTLIVES the
-- erased data (and the erasure_subjects rows, which are deleted post-erasure);
-- it must never hold the subject's plaintext.
--
-- Phase 1 creates the table only — the finder/executor that populate it are
-- gated behind later phases + ERASURE_EXECUTE_ENABLED (inert here).

CREATE TABLE IF NOT EXISTS erasure_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  subject_ids text[] NOT NULL,                 -- hashed locators, never raw PII
  raw_identifier_fingerprint text,             -- hash of operator input, for dedup/audit
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','finding','found','erasing','done','partial','failed')),
  coverage text
    CHECK (coverage IN ('full_within_window','partial','unknown')),
  index_window_from timestamptz,               -- source subject_indexing_active_since
  matched_event_count integer,
  store_results jsonb,                         -- per-store: deleted / skipped / uncertain / out_of_scope
  deletion_manifest_hash text,                 -- hash over sorted (event_id, r2_key) actually deleted
  uncovered_disclosure jsonb,                  -- windows/stores we could NOT search or confirm
  requested_by_user_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS erasure_requests_workspace_idx
  ON erasure_requests (workspace_id, requested_at DESC);
