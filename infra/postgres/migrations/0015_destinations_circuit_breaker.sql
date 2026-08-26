-- Migration 0015: per-destination circuit-breaker state (AXE-27).
--
-- Adds the fields the delivery worker needs to short-circuit deliveries
-- to a destination that's been failing repeatedly. Lifecycle:
--   closed → open (after N consecutive failures within a window)
--   open → half_open (after cooldown elapses)
--   half_open → closed (probe succeeds) | open (probe fails)
--   any → disabled (manual)
--
-- All transitions are recorded in audit_log via the delivery-service
-- (rows here just hold the latest state to keep the worker hot path
-- a single SELECT).

ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS circuit_state TEXT NOT NULL DEFAULT 'closed'
    CHECK (circuit_state IN ('closed', 'open', 'half_open', 'disabled')),
  ADD COLUMN IF NOT EXISTS circuit_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS circuit_half_open_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS circuit_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Operator-tunable trip thresholds. Defaults: 5 consecutive failures
  -- (any retry/fail status), 60s cooldown before the next probe.
  ADD COLUMN IF NOT EXISTS circuit_threshold_failures INTEGER NOT NULL DEFAULT 5
    CHECK (circuit_threshold_failures >= 1),
  ADD COLUMN IF NOT EXISTS circuit_cooldown_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (circuit_cooldown_seconds >= 1);

-- Partial index: only non-closed destinations are interesting for the
-- worker's "should I skip?" SELECT. Keeps the index tiny in steady-state.
CREATE INDEX IF NOT EXISTS destinations_circuit_state_idx
  ON destinations (workspace_id, circuit_state)
  WHERE circuit_state <> 'closed';
