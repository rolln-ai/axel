-- Migration 0016: per-destination delivery controls (AXE-28).
--
-- Builds on the 0015 breaker columns with operator-tunable
-- throughput controls:
--   delivery_paused            : operator pause (independent of breaker)
--   rate_limit_rps             : token-bucket cap, NULL = unlimited
--   rate_tokens / updated_at   : token bucket state, atomic update
--   request_timeout_ms         : per-attempt fetch() AbortController budget
--   retry_after_until          : honored 429 Retry-After header window
--
-- All checked by the delivery-service breaker acquire() hook so the
-- worker doesn't need a new dep.

ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS delivery_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delivery_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS rate_limit_rps INTEGER
    CHECK (rate_limit_rps IS NULL OR rate_limit_rps >= 1),
  ADD COLUMN IF NOT EXISTS rate_tokens DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS rate_tokens_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS request_timeout_ms INTEGER
    CHECK (request_timeout_ms IS NULL OR (request_timeout_ms >= 100 AND request_timeout_ms <= 300000)),
  ADD COLUMN IF NOT EXISTS retry_after_until TIMESTAMPTZ;

-- Speed up "find paused destinations" scans (rare, but cheap to index).
CREATE INDEX IF NOT EXISTS destinations_delivery_paused_idx
  ON destinations (workspace_id)
  WHERE delivery_paused;
