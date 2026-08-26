-- Axel control-plane schema.
-- Postgres owns configuration and idempotency state. High-volume event and
-- attempt search belongs in ClickHouse; keep this schema lean.

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS slug text UNIQUE;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

-- AXE-35: per-workspace retention defaults. See migration 0018; caps
-- tightened in 0048 (raw_payload default 90 -> 30 to match the fixed
-- 30-day R2 lifecycle; dead_letter capped 365, replay 90). CHECK
-- constraints live in those migrations, not this lean snapshot.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS raw_payload_retention_days integer NOT NULL DEFAULT 30;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS dead_letter_retention_days integer NOT NULL DEFAULT 90;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS replay_request_retention_days integer NOT NULL DEFAULT 30;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS audit_log_retention_days integer NOT NULL DEFAULT 365;

-- 0057: super-admin comp flag. When true the ingest billing gate (deriveGate)
-- short-circuits to 'accept' — no card required, no quota block, no suspension.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_exempt boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_email_idx
  ON users (lower(email));

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx
  ON workspace_members (user_id, workspace_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  invited_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_invites_workspace_idx
  ON workspace_invites (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx
  ON user_sessions (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx
  ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx
  ON password_resets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS password_resets_expiry_idx
  ON password_resets (expires_at)
  WHERE used_at IS NULL;

-- Email-verification tokens (migration 0064). Same shape/lifecycle as
-- password_resets: sha256(token) stored, single-use via used_at, TTL via
-- expires_at. Confirming a token stamps users.email_verified_at. See
-- apps/dashboard/lib/email-verification.ts.
CREATE TABLE IF NOT EXISTS email_verifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verifications_user_idx
  ON email_verifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS email_verifications_expiry_idx
  ON email_verifications (expires_at)
  WHERE used_at IS NULL;

-- Auth rate-limiting buckets (fixed-window). See migration 0042 +
-- apps/dashboard/lib/rate-limit.ts. Postgres-backed so the limit is shared
-- across serverless instances (an in-memory limiter would reset per cold start).
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx ON auth_rate_limits (window_start);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_workspace_time_idx
  ON audit_log (workspace_id, created_at DESC);

-- Clickwrap consent record. One row per acceptance event (signup / invite
-- signup), capturing which documents + versions were agreed to and the
-- evidentiary context (IP, user-agent, timestamp). See migration 0051.
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  terms_version text NOT NULL,
  document_versions jsonb NOT NULL,
  context text NOT NULL DEFAULT 'signup'
    CHECK (context IN ('signup', 'invite_signup', 're_consent')),
  ip text,
  user_agent text,
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS terms_acceptances_user_idx
  ON terms_acceptances (user_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  secret_token_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  -- AXE-23: provider preset + encrypted signing secret. The ingest worker
  -- rejects requests that fail the provider's HMAC check before writing
  -- to R2 or the queue. NULL ciphertext = no signature verification
  -- (token-only). See migration 0010 for column semantics.
  provider text NOT NULL DEFAULT 'custom'
    CHECK (provider IN ('custom', 'stripe', 'github', 'shopify', 'chargebee')),
  signing_secret_ciphertext bytea,
  signing_secret_fingerprint text,
  -- Rotation overlap window: the previous signing secret is kept so webhooks
  -- still signed with the old secret verify until it's retired. See 0043.
  signing_secret_previous_ciphertext bytea,
  signing_secret_previous_fingerprint text,
  signing_secret_rotated_at timestamptz,
  -- PII redaction paths (dot-paths, `[]` for arrays) masked at ingest before
  -- the R2 write. NULL/empty = no redaction. See migration 0041.
  redact_paths jsonb,
  max_body_bytes integer,
  max_body_depth integer,
  max_events_per_minute integer,
  -- AXE-34: inbound IP allowlist (text[] of CIDRs). Empty = no
  -- allowlist (accept any IP). See migration 0017.
  inbound_ip_allowlist text[] NOT NULL DEFAULT '{}',
  -- FIFO/ordered delivery (Phase 1). Opt-in, default-off. See migration 0044.
  ordering_enabled boolean NOT NULL DEFAULT false,
  ordering_key_header text,
  ordering_key_path text,
  -- GDPR per-subject erasure (Phase 1). Operator-configured subject-id paths
  -- (jsonb) + the time indexing began. NULL = no extraction. See migration 0045.
  subject_key_paths jsonb,
  subject_indexing_active_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotent ALTERs for pre-AXE-23 databases.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'custom';
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_ciphertext bytea;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_fingerprint text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_previous_ciphertext bytea;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_previous_fingerprint text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_rotated_at timestamptz;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS redact_paths jsonb;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS inbound_ip_allowlist text[] NOT NULL DEFAULT '{}';
-- AXE-35: per-source transient + retention override.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS transient_mode boolean NOT NULL DEFAULT FALSE;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS raw_payload_retention_days integer;
-- FIFO/ordered delivery (Phase 1). See migration 0044.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS ordering_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS ordering_key_header text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS ordering_key_path text;
-- GDPR per-subject erasure (Phase 1). See migration 0045.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS subject_key_paths jsonb;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS subject_indexing_active_since timestamptz;

CREATE INDEX IF NOT EXISTS sources_workspace_status_idx
  ON sources (workspace_id, status);

-- Per-workspace name uniqueness. Application code already rejects duplicate
-- names but READ COMMITTED can race; this turns the race into a clean
-- 23505 unique_violation. NULL `name` rows (legacy) are not considered
-- equal under UNIQUE, so they don't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS sources_workspace_lower_name_idx
  ON sources (workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS routes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'errored')),
  engine text NOT NULL DEFAULT 'declarative'
    CHECK (engine IN ('legacy_js', 'declarative')),
  filter_expression text,
  transform_script text,
  pipeline_graph jsonb,
  error_reason text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routes_source_active_idx
  ON routes (workspace_id, source_id)
  WHERE status = 'active';

-- engine column for existing routes tables. Fresh databases get it via
-- the CREATE TABLE above; this ALTER catches databases that pre-date
-- migration 0007 (and is a no-op on fresh ones thanks to IF NOT EXISTS).
-- The partial index below must follow this ALTER.
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'declarative';
ALTER TABLE routes
  ALTER COLUMN engine SET DEFAULT 'declarative';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_name = 'routes'
       AND constraint_name = 'routes_engine_check'
  ) THEN
    ALTER TABLE routes
      ADD CONSTRAINT routes_engine_check
      CHECK (engine IN ('legacy_js', 'declarative'));
  END IF;
END$$;

-- AXE-24: any route carrying a filter or transform must use the
-- declarative engine. The legacy_js path was never wired up in the
-- production edge router and quietly dead-lettered every event. Migration
-- 0009 disables existing rows that violated this; this constraint
-- prevents the broken combination from being reintroduced.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_name = 'routes'
       AND constraint_name = 'routes_filter_transform_declarative_only'
  ) THEN
    ALTER TABLE routes
      ADD CONSTRAINT routes_filter_transform_declarative_only
      CHECK (
        (filter_expression IS NULL AND transform_script IS NULL)
        OR engine = 'declarative'
      );
  END IF;
END$$;

-- DAG pipeline_graph column (see migration 0035). When set, the router
-- ignores filter_expression / transform_script and walks the graph via
-- executeGraph in @axel/shared. The CHECK enforces that the legacy
-- single-shape fields and the graph can't coexist on a single row.
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS pipeline_graph jsonb;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_name = 'routes'
       AND constraint_name = 'routes_pipeline_graph_excludes_legacy'
  ) THEN
    ALTER TABLE routes
      ADD CONSTRAINT routes_pipeline_graph_excludes_legacy
      CHECK (
        pipeline_graph IS NULL
        OR (filter_expression IS NULL AND transform_script IS NULL)
      );
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS routes_declarative_active_idx
  ON routes (workspace_id, source_id)
  WHERE engine = 'declarative' AND status = 'active';

CREATE TABLE IF NOT EXISTS destinations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('mongodb', 'postgres', 'r2', 's3', 'http', 'webhook', 'databricks_sql', 'databricks_volume', 'bigquery')),
  name text,
  config jsonb NOT NULL,
  credentials_ref text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- AXE-27 circuit breaker. See migration 0015.
  circuit_state text NOT NULL DEFAULT 'closed'
    CHECK (circuit_state IN ('closed', 'open', 'half_open', 'disabled')),
  circuit_opened_at timestamptz,
  circuit_half_open_at timestamptz,
  circuit_consecutive_failures integer NOT NULL DEFAULT 0,
  circuit_threshold_failures integer NOT NULL DEFAULT 5
    CHECK (circuit_threshold_failures >= 1),
  circuit_cooldown_seconds integer NOT NULL DEFAULT 60
    CHECK (circuit_cooldown_seconds >= 1),
  -- AXE-28 delivery controls. See migration 0016.
  delivery_paused boolean NOT NULL DEFAULT FALSE,
  delivery_paused_at timestamptz,
  delivery_paused_reason text,
  rate_limit_rps integer
    CHECK (rate_limit_rps IS NULL OR rate_limit_rps >= 1),
  rate_tokens double precision,
  rate_tokens_updated_at timestamptz,
  request_timeout_ms integer
    CHECK (request_timeout_ms IS NULL OR (request_timeout_ms >= 100 AND request_timeout_ms <= 300000)),
  retry_after_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotent ALTERs for pre-AXE-27/28 databases. `CREATE TABLE IF
-- NOT EXISTS` above is a no-op on production where `destinations`
-- already exists, so the new inline columns never get added without
-- these explicit ALTERs. Each ALTER is independently idempotent so
-- partially-applied schemas catch up cleanly.
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS circuit_state text NOT NULL DEFAULT 'closed';
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS circuit_opened_at timestamptz;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS circuit_half_open_at timestamptz;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS circuit_consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS circuit_threshold_failures integer NOT NULL DEFAULT 5;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS circuit_cooldown_seconds integer NOT NULL DEFAULT 60;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS delivery_paused boolean NOT NULL DEFAULT FALSE;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS delivery_paused_at timestamptz;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS delivery_paused_reason text;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS rate_limit_rps integer;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS rate_tokens double precision;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS rate_tokens_updated_at timestamptz;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS request_timeout_ms integer;
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS retry_after_until timestamptz;

-- AXE-28: cheap probe to find paused destinations.
CREATE INDEX IF NOT EXISTS destinations_delivery_paused_idx
  ON destinations (workspace_id)
  WHERE delivery_paused;

-- AXE-27: partial index for non-closed destinations only.
-- (See sources block above for AXE-34 inbound_ip_allowlist column.)

CREATE INDEX IF NOT EXISTS destinations_circuit_state_idx
  ON destinations (workspace_id, circuit_state)
  WHERE circuit_state <> 'closed';

CREATE INDEX IF NOT EXISTS destinations_workspace_idx
  ON destinations (workspace_id);

-- See sources_workspace_lower_name_idx for rationale.
CREATE UNIQUE INDEX IF NOT EXISTS destinations_workspace_lower_name_idx
  ON destinations (workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS route_destinations (
  route_id text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  destination_id text NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  -- Per-route binding: { table }/{ collection }/{ key_prefix } etc.
  -- See migration 0022. NULL falls back to destinations.config.
  binding jsonb,
  PRIMARY KEY (route_id, destination_id)
);

ALTER TABLE route_destinations
  ADD COLUMN IF NOT EXISTS binding jsonb;

CREATE TABLE IF NOT EXISTS delivery_idempotency (
  idempotency_key text PRIMARY KEY,
  workspace_id text NOT NULL,
  event_id text NOT NULL,
  route_id text NOT NULL,
  destination_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('in_flight', 'completed', 'failed')),
  attempt_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Renewable claim deadline while in_flight; 14-day retention deadline after
  -- completed/failed settlement. Both runtimes use the shared SQL protocol.
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS delivery_idempotency_expiry_idx
  ON delivery_idempotency (expires_at);

CREATE INDEX IF NOT EXISTS delivery_idempotency_workspace_idx
  ON delivery_idempotency (workspace_id);

CREATE TABLE IF NOT EXISTS dead_letters (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  event_id text NOT NULL,
  source_id text NOT NULL,
  route_id text NOT NULL,
  r2_key text NOT NULL,
  reason text NOT NULL,
  message text NOT NULL,
  is_test boolean NOT NULL DEFAULT false,
  errored_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by_replay_id text
);

CREATE INDEX IF NOT EXISTS dead_letters_workspace_time_idx
  ON dead_letters (workspace_id, errored_at DESC);

CREATE INDEX IF NOT EXISTS dead_letters_workspace_source_reason_event_route_idx
  ON dead_letters (workspace_id, source_id, reason, event_id, route_id, errored_at);

CREATE INDEX IF NOT EXISTS dead_letters_workspace_event_route_reason_idx
  ON dead_letters (workspace_id, event_id, route_id, reason, errored_at);

CREATE INDEX IF NOT EXISTS dead_letters_workspace_event_route_key_reason_idx
  ON dead_letters (workspace_id, event_id, COALESCE(route_id, ''), reason, errored_at);

CREATE INDEX IF NOT EXISTS dead_letters_workspace_unresolved_time_idx
  ON dead_letters (workspace_id, errored_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS dead_letters_workspace_unresolved_reason_time_idx
  ON dead_letters (workspace_id, reason, errored_at DESC)
  WHERE resolved_at IS NULL;

-- Replay requests are written by the dashboard and consumed by the router.
-- A replay re-fetches the raw payload from R2 (via r2_key) and re-runs the
-- routing pipeline. State transitions: pending -> in_progress in the router;
-- the delivery service then marks done|failed after the replayed destination
-- attempt actually succeeds or reaches a terminal failure.
CREATE TABLE IF NOT EXISTS replay_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  source_id text NOT NULL,
  r2_key text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('route', 'destination', 'all')),
  route_id text,
  destination_id text,
  state text NOT NULL CHECK (state IN ('pending', 'in_progress', 'done', 'failed')),
  reason text,
  failure_reason text,
  requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  CONSTRAINT replay_requests_workspace_r2_key_check CHECK (
    state IN ('done', 'failed')
    OR (
      split_part(r2_key, '/', 1) IN ('events', 'pull')
      AND split_part(r2_key, '/', 2) = workspace_id
      AND split_part(r2_key, '/', 3) <> ''
      AND r2_key NOT LIKE '%//%'
      AND r2_key !~ '(^|/)([.]{1,2})(/|$)'
    )
  )
);

CREATE INDEX IF NOT EXISTS replay_requests_workspace_time_idx
  ON replay_requests (workspace_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS replay_requests_pending_idx
  ON replay_requests (state, requested_at)
  WHERE state = 'pending';

-- GDPR per-subject erasure (Phase 1 foundation). See migrations 0046, 0047.
-- subject -> event index (hashed locators, never raw PII) + request audit trail.
-- Inert in Phase 1: no code writes these until the finder/executor phases.
CREATE TABLE IF NOT EXISTS erasure_subjects (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  subject_id text NOT NULL,
  event_id text NOT NULL,
  r2_key text,
  received_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS erasure_subjects_lookup_idx
  ON erasure_subjects (workspace_id, subject_id);
CREATE INDEX IF NOT EXISTS erasure_subjects_event_idx
  ON erasure_subjects (workspace_id, event_id);

CREATE TABLE IF NOT EXISTS erasure_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  subject_ids text[] NOT NULL,
  raw_identifier_fingerprint text,
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','finding','found','erasing','done','partial','failed')),
  coverage text
    CHECK (coverage IN ('full_within_window','partial','unknown')),
  index_window_from timestamptz,
  matched_event_count integer,
  store_results jsonb,
  deletion_manifest_hash text,
  uncovered_disclosure jsonb,
  requested_by_user_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS erasure_requests_workspace_idx
  ON erasure_requests (workspace_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS replay_requests_resolution_lookup_idx
  ON replay_requests (workspace_id, event_id, route_id, state, requested_at, finished_at);

CREATE INDEX IF NOT EXISTS replay_requests_workspace_state_event_route_idx
  ON replay_requests (workspace_id, state, event_id, route_id, requested_at);

CREATE INDEX IF NOT EXISTS replay_requests_workspace_state_event_route_key_idx
  ON replay_requests (workspace_id, state, event_id, COALESCE(route_id, ''), requested_at);

CREATE INDEX IF NOT EXISTS replay_requests_active_failure_reason_idx
  ON replay_requests (workspace_id, failure_reason, state)
  WHERE scope = 'route'
    AND state IN ('pending', 'in_progress')
    AND failure_reason IS NOT NULL;

-- Used by the dashboard's "is this dead-letter resolved by a successful
-- replay?" filter on /deliveries and /dashboard. The dead_letters lookup
-- joins on (workspace_id, event_id, route_id) and only cares about rows
-- where state='done', so a partial index keeps this O(log n) even when the
-- replay history grows large.
CREATE INDEX IF NOT EXISTS replay_requests_done_lookup_idx
  ON replay_requests (workspace_id, event_id, route_id, finished_at)
  WHERE state = 'done';

CREATE INDEX IF NOT EXISTS replay_requests_done_route_lookup_idx
  ON replay_requests (workspace_id, event_id, route_id, finished_at)
  WHERE state = 'done'
    AND scope = 'route'
    AND finished_at IS NOT NULL;

-- AXE-66 — Backfill jobs. Async long-running batches that paginate ClickHouse
-- and feed `replay_requests` in throttled chunks. The dashboard inserts a job
-- row; the delivery-service worker drains it by repeatedly:
--   1. count pending replay_requests linked to this job
--   2. if below max_inflight_replays, pull the next ClickHouse window from
--      (cursor_received_at, cursor_event_id) and bulk-insert replays
--   3. update cursor + enqueued counter
--   4. when the window is exhausted, mark `done`
--
-- This is the right shape for very large backfills (millions+) because it
-- never holds more than ~max_inflight_replays rows in `replay_requests` at
-- once and it never SELECTs more than one window's worth of ClickHouse rows.
CREATE TABLE IF NOT EXISTS backfill_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  route_id text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  since timestamptz NOT NULL,
  until timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  total_estimated bigint,
  enqueued bigint NOT NULL DEFAULT 0,
  -- Pagination cursor. NULL until the worker's first batch — at that point
  -- we record (received_at, event_id) of the last row enqueued so the next
  -- batch starts strictly after it. ClickHouse `events` is ORDER BY
  -- (workspace_id, received_at, source_id, event_id) so this is a cheap seek.
  cursor_received_at timestamptz,
  cursor_event_id text,
  -- Throttle: worker will not enqueue more replays for this job while
  -- (pending replays for this job) >= this number. Bounds memory in
  -- replay_requests and (more importantly) bounds the rate at which the
  -- customer destination sees backfilled traffic.
  max_inflight_replays integer NOT NULL DEFAULT 1000,
  requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);

-- Worker pick-up index. We only ever scan for jobs in active states.
CREATE INDEX IF NOT EXISTS backfill_jobs_active_idx
  ON backfill_jobs (requested_at)
  WHERE state IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS backfill_jobs_workspace_idx
  ON backfill_jobs (workspace_id, requested_at DESC);

-- Link replay_requests back to the backfill job that created them so the
-- worker can throttle on a per-job basis (instead of counting every pending
-- replay in the workspace, which would conflate dashboard "Retry" clicks
-- with the job's own queue).
ALTER TABLE replay_requests
  ADD COLUMN IF NOT EXISTS backfill_job_id text REFERENCES backfill_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS replay_requests_backfill_job_pending_idx
  ON replay_requests (backfill_job_id)
  WHERE state = 'pending' AND backfill_job_id IS NOT NULL;

-- Dedupe backfill-generated rows so a crash-replayed window can't enqueue
-- the same event twice (backs ON CONFLICT in the backfill worker). Partial
-- so it never constrains ordinary non-backfill replays (NULL backfill_job_id).
CREATE UNIQUE INDEX IF NOT EXISTS replay_requests_backfill_event_uniq
  ON replay_requests (backfill_job_id, event_id)
  WHERE backfill_job_id IS NOT NULL;

-- Tracked "replay all unresolved" jobs. See migration 0050.
--
-- One row per "Replay all N unresolved" click on /deliveries (mirrors
-- backfill_jobs). Gives the dashboard a durable progress object (queued /
-- in-flight / succeeded / failed) and lets the delivery-service worker detect
-- completion and emit one "replay_job_complete" notification. The denormalized
-- succeeded_count/failed_count make completion detection + the terminal
-- notification cheap; the live UI prefers a GROUP BY over replay_requests.state
-- and the worker recomputes authoritative counts in the atomic finish UPDATE.
CREATE TABLE IF NOT EXISTS replay_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  reason_filter text,
  total bigint NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  succeeded_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);

-- Dashboard reads the most recent active job per workspace; the worker's
-- completion path also keys on this. Covers (workspace_id, state) lookups and
-- the active-job scan.
CREATE INDEX IF NOT EXISTS replay_jobs_workspace_state_idx
  ON replay_jobs (workspace_id, state);

CREATE INDEX IF NOT EXISTS replay_jobs_active_idx
  ON replay_jobs (requested_at)
  WHERE state IN ('pending', 'running');

-- Link replay_requests back to the replay_jobs row that created them so the
-- worker can count remaining in-flight rows for completion detection and
-- attribute succeeded/failed deltas to the right job. Nullable; ON DELETE SET
-- NULL so deleting a job leaves the replays intact (mirrors backfill_job_id).
ALTER TABLE replay_requests
  ADD COLUMN IF NOT EXISTS replay_job_id text REFERENCES replay_jobs(id) ON DELETE SET NULL;

-- Completion check scans replay_requests WHERE replay_job_id=$1 AND state IN
-- ('pending','in_progress'); a partial index keeps that cheap and never
-- constrains ordinary non-job replays (NULL replay_job_id).
CREATE INDEX IF NOT EXISTS replay_requests_replay_job_idx
  ON replay_requests (replay_job_id)
  WHERE replay_job_id IS NOT NULL;

-- Encrypted credential storage for destinations.
--
-- Each row is the result of a single AES-256-GCM `encryptCredential(plaintext)`
-- call under $CREDENTIALS_MASTER_KEY: ciphertext + 12-byte nonce + 16-byte
-- auth tag. The same master key must exist on dashboard (encrypt path) and
-- on delivery-edge / delivery-service (decrypt path).
--
-- Fingerprint columns (last4 + sha256_prefix) let the UI confirm "this is
-- the credential I just rotated" without ever decrypting.
--
-- destinations.credentials_ref points at this table's id. The deferred
-- composite foreign key below binds a non-null reference to the same
-- destination and workspace while still allowing both circular rows to be
-- created in one transaction. A destination can remain credential-free.
CREATE TABLE IF NOT EXISTS destination_credentials (
  id text PRIMARY KEY,
  destination_id text NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  fingerprint_last4 text NOT NULL,
  fingerprint_sha256_prefix text NOT NULL,
  encryption_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS destination_credentials_destination_idx
  ON destination_credentials (destination_id);

CREATE UNIQUE INDEX IF NOT EXISTS destination_credentials_binding_idx
  ON destination_credentials (id, destination_id, workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'destinations_credentials_binding_fkey'
       AND conrelid = 'destinations'::regclass
  ) THEN
    ALTER TABLE destinations
      ADD CONSTRAINT destinations_credentials_binding_fkey
      FOREIGN KEY (credentials_ref, id, workspace_id)
      REFERENCES destination_credentials(id, destination_id, workspace_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- Optional name column on destinations to give the UI a friendly label.
-- Kept as an ALTER for existing databases; fresh databases get the column in
-- the CREATE TABLE above before indexes reference it.
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS name text;

-- Per-source field allowlist. When non-null, the router projects each event's
-- decoded payload to ONLY these dot-paths before fanning out to destinations.
-- Empty / null = pass through unchanged (default behavior).
--
-- Stored as a jsonb array of strings, e.g. `["customer.email","amount","event_id"]`.
-- The R2-stored raw payload is never modified — projection happens in the
-- router on the way to the delivery queue, so customers can replay a row
-- with the original payload if they later widen the selection.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS field_selection jsonb;

-- Pull-based ELT source configuration and checkpoints.
--
-- Webhook sources continue to live in `sources`; pull_sources are scheduled
-- extractors (Chargebee first) whose emitted records can be routed through the
-- same downstream delivery pipeline.
CREATE TABLE IF NOT EXISTS pull_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- AXE-60 widened the set: API pulls (chargebee/stripe/shopify) plus
  -- DB pulls (postgres/mongodb/bigquery). Migration 0014 drops the
  -- prior chargebee-only CHECK on pre-existing databases.
  type text NOT NULL CHECK (type IN ('chargebee', 'stripe', 'shopify', 'postgres', 'mongodb', 'bigquery')),
  config jsonb NOT NULL,
  credentials_ref text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  schedule_cron text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pull_sources_workspace_status_idx
  ON pull_sources (workspace_id, status);

CREATE TABLE IF NOT EXISTS pull_source_credentials (
  id text PRIMARY KEY,
  pull_source_id text NOT NULL REFERENCES pull_sources(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  fingerprint_last4 text NOT NULL,
  fingerprint_sha256_prefix text NOT NULL,
  encryption_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pull_source_credentials_source_idx
  ON pull_source_credentials (pull_source_id);

CREATE UNIQUE INDEX IF NOT EXISTS pull_source_credentials_binding_idx
  ON pull_source_credentials (id, pull_source_id, workspace_id);

-- Match the destination credential invariant above: a non-null current
-- credential must belong to this exact pull source and workspace. Deferred so
-- the circular source + credential rows can be created in one transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'pull_sources_credentials_binding_fkey'
       AND conrelid = 'pull_sources'::regclass
  ) THEN
    ALTER TABLE pull_sources
      ADD CONSTRAINT pull_sources_credentials_binding_fkey
      FOREIGN KEY (credentials_ref, id, workspace_id)
      REFERENCES pull_source_credentials(id, pull_source_id, workspace_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS pull_source_stream_state (
  pull_source_id text NOT NULL REFERENCES pull_sources(id) ON DELETE CASCADE,
  stream text NOT NULL,
  cursor jsonb,
  -- Migration 0055: per-page resume token (the connector's nextCursor /
  -- starting_after, see pull-connectors runner.ts). Persisted per page so a
  -- mid-pageset crash resumes pagination from the interrupted page instead of
  -- restarting from page 1 (which, for descending streams like Stripe, re-ingests
  -- every prior page). Without this column the runner's resumePageCursor was
  -- silently dropped and the resume was inoperative.
  resume_page_cursor text,
  -- Highest cursor seen across an in-flight pageset. The committed cursor stays
  -- pinned until resume_page_cursor drains, then this value becomes the new
  -- committed cursor so newest-first capped runs do not regress/re-emit pages.
  pending_high_watermark jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pull_source_id, stream)
);
-- Idempotent for environments created before resume_page_cursor existed (this
-- file is applied to prod via migrate-postgres.yml, where the CREATE above is a
-- no-op on the existing table).
ALTER TABLE pull_source_stream_state
  ADD COLUMN IF NOT EXISTS resume_page_cursor text;
ALTER TABLE pull_source_stream_state
  ADD COLUMN IF NOT EXISTS pending_high_watermark jsonb;

CREATE TABLE IF NOT EXISTS pull_sync_runs (
  id text PRIMARY KEY,
  pull_source_id text NOT NULL REFERENCES pull_sources(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  records_emitted integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text
);

CREATE INDEX IF NOT EXISTS pull_sync_runs_source_time_idx
  ON pull_sync_runs (pull_source_id, started_at DESC);

CREATE INDEX IF NOT EXISTS pull_sync_runs_workspace_time_idx
  ON pull_sync_runs (workspace_id, started_at DESC);

-- Global "super-admin" flag. Defaulted false so existing users stay non-admin;
-- promote individuals with `UPDATE users SET is_super_admin = true WHERE ...`.
-- Read by lib/admin-auth.ts to gate the /admin section.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;

-- Workspace lifecycle. `status='suspended'` blocks mutating actions via
-- lib/session.ts#assertWorkspaceWritable but keeps the data visible.
-- `status='deleted'` is reserved for admin soft-delete. `status='deleting'` is
-- the interim state for self-serve deletion: the action flips to 'deleting' and
-- the workspace-teardown cron does the heavy wipe + hard DELETE out of band
-- (see migration 0056). FK cascades still sweep dependent rows on the final
-- hard DELETE.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted', 'deleting'));
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspended_by_user_id text
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspension_reason text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- Set when the final metered usage has been reported to the Stripe meter during
-- teardown; gates a settle delay before the subscription is canceled so the
-- final invoice captures every event sent before deletion.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS usage_flushed_at timestamptz;

-- Impersonation marker on the session row. When set, the session belongs to
-- `user_id` but was created by `impersonator_user_id` (a super-admin). The
-- impersonator_returns_to_session_id points back at the admin's prior session
-- so "Stop impersonating" can restore it.
ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS impersonator_user_id text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS impersonator_returns_to_session_id text;

CREATE INDEX IF NOT EXISTS user_sessions_impersonator_idx
  ON user_sessions (impersonator_user_id) WHERE impersonator_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspaces_status_idx
  ON workspaces (status) WHERE status <> 'active';

-- In-app notifications (AXE-48). Drift detection (AXE-47) + failure
-- explanation (AXE-49) emit rows here; UI consumes via the bell icon
-- and /notifications page.
CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'high')),
  title text NOT NULL,
  body_md text,
  link_path text,
  dedup_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  -- Set when the immediate alert lane (lib/notification-alerts.ts) has already
  -- emailed this notification, so the daily digest excludes it (no double-send).
  alerted_at timestamptz
);

CREATE INDEX IF NOT EXISTS notifications_workspace_user_idx
  ON notifications (workspace_id, COALESCE(user_id, ''), created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_workspace_unread_idx
  ON notifications (workspace_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_active_dedup_idx
  ON notifications (workspace_id, COALESCE(user_id, ''), kind, dedup_key)
  WHERE read_at IS NULL AND dedup_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_preferences (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Resolve-aware dedup ledger for "a new error type started occurring" alerts
-- (migration 0052). A row exists while a dead-letter fingerprint is actively
-- failing; the 15-min notification scan inserts on first sight (the ON CONFLICT
-- RETURNING row drives the single alert email) and deletes the row once the
-- fingerprint is no longer active, so a resolved-then-recurring error re-alerts
-- as a fresh incident. See lib/notification-scan.ts.
CREATE TABLE IF NOT EXISTS notification_active_errors (
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint      text NOT NULL,
  reason           text NOT NULL,
  first_alerted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, fingerprint)
);

-- One row per recipient per UTC day: the claim to send that day's digest
-- (migration 0063). The digest job inserts ON CONFLICT DO NOTHING RETURNING
-- before sending, so a retried or manually re-triggered cron mails nobody a
-- second copy; the claim is released again when the send fails. See
-- lib/data-contracts/email-digest.ts.
CREATE TABLE IF NOT EXISTS digest_sends (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_date  date NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, digest_date)
);

CREATE INDEX IF NOT EXISTS digest_sends_date_idx ON digest_sends (digest_date);

-- Data Contracts (formerly "Event Maps", renamed in migration 0024) — Axel's
-- AI-native event understanding layer (AXE-22). See migrations 0006 (original)
-- + 0024 (rename) for rationale. A Data Contract is a durable, versioned schema
-- + transform contract for a source. Versions are immutable. Raw payloads are
-- never stored here; only references back into ClickHouse/R2.
--
-- These definitions MUST use the post-0024 names: this schema.sql is applied
-- verbatim to fresh/CI environments (and, via migrate-postgres.yml, prod). The
-- repository queries target data_contracts*; keeping the legacy event_maps*
-- names here created empty ghost tables on migrated DBs and dead-on-arrival
-- fresh environments.
CREATE TABLE IF NOT EXISTS data_contracts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  route_id text REFERENCES routes(id) ON DELETE SET NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  current_version_id text,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_contracts_workspace_source_idx
  ON data_contracts (workspace_id, source_id);

CREATE INDEX IF NOT EXISTS data_contracts_workspace_status_idx
  ON data_contracts (workspace_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS data_contracts_workspace_lower_name_idx
  ON data_contracts (workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS data_contract_versions (
  id text PRIMARY KEY,
  data_contract_id text NOT NULL REFERENCES data_contracts(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  inferred_schema jsonb NOT NULL,
  field_annotations jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_filter text,
  generated_transform text,
  transform_language text
    CHECK (transform_language IN ('jsonata', 'js')),
  destination_mapping jsonb,
  model_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  fixture_results jsonb,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (data_contract_id, version_number)
);

CREATE INDEX IF NOT EXISTS data_contract_versions_map_created_idx
  ON data_contract_versions (data_contract_id, created_at DESC);

CREATE TABLE IF NOT EXISTS data_contract_fixtures (
  id text PRIMARY KEY,
  data_contract_version_id text NOT NULL
    REFERENCES data_contract_versions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_event_id text,
  event_type text,
  input_payload jsonb NOT NULL,
  expected_output jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_contract_fixtures_version_idx
  ON data_contract_fixtures (data_contract_version_id);

CREATE TABLE IF NOT EXISTS data_contract_drift_events (
  id bigserial PRIMARY KEY,
  data_contract_id text NOT NULL REFERENCES data_contracts(id) ON DELETE CASCADE,
  data_contract_version_id text NOT NULL
    REFERENCES data_contract_versions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN (
    'new_event_type',
    'missing_field',
    'type_change',
    'new_sensitive_field',
    'unknown_shape'
  )),
  field_path text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_event_id text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS data_contract_drift_events_unresolved_idx
  ON data_contract_drift_events (workspace_id, data_contract_id, observed_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS data_contract_drift_events_workspace_time_idx
  ON data_contract_drift_events (workspace_id, observed_at DESC);

-- AXE-26: workspace-scoped Personal Access Tokens used by the Axel
-- CLI. Stored as SHA-256 hash; plaintext is shown to the operator
-- exactly once at mint time. Scope is (user, workspace) so revoking a
-- workspace member also cuts their CLI access.
CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT personal_access_tokens_membership_fkey
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS personal_access_tokens_hash_idx
  ON personal_access_tokens (token_hash);

CREATE INDEX IF NOT EXISTS personal_access_tokens_user_idx
  ON personal_access_tokens (workspace_id, user_id, created_at DESC);

-- Heartbeats: each worker writes a row per tick so the admin/status
-- pages can detect silent stalls. See migration 0020.
CREATE TABLE IF NOT EXISTS component_heartbeats (
  component text PRIMARY KEY,
  environment text,
  last_seen timestamptz NOT NULL DEFAULT now(),
  last_tick_count bigint NOT NULL DEFAULT 0,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_interval_seconds integer NOT NULL DEFAULT 60,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS component_heartbeats_last_seen_idx
  ON component_heartbeats (last_seen);

-- Hourly snapshot history. See migration 0021. Retention loop
-- writes one row per (component, hour bucket) per tick and prunes
-- rows older than 7d. ON CONFLICT lets re-runs in the same hour
-- be idempotent.
CREATE TABLE IF NOT EXISTS component_heartbeat_history (
  component text NOT NULL,
  bucket_start timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('green', 'yellow', 'red', 'unknown')),
  PRIMARY KEY (component, bucket_start)
);

CREATE INDEX IF NOT EXISTS component_heartbeat_history_bucket_idx
  ON component_heartbeat_history (bucket_start);

-- AXE-29: workspace-scoped API keys for the REST control plane. See
-- migration 0019. Placed after `users` is created so the
-- created_by_user_id FK resolves.
CREATE TABLE IF NOT EXISTS workspace_api_keys (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{read}',
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (cardinality(scopes) > 0)
);

CREATE INDEX IF NOT EXISTS workspace_api_keys_workspace_idx
  ON workspace_api_keys (workspace_id) WHERE revoked_at IS NULL;

-- AXE-54: AI-generated dead letter explanations cache.
ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS ai_summary text;
ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS ai_suggested_action text;
ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS ai_summarized_at timestamptz;

-- Migration 0049: which destination a per-destination failure targeted.
-- Nullable — route-level and pre-routing failures have no single destination,
-- and rows written before 0049 have none. See investigate page.
ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS destination_id text;

-- Migration 0053: store the dead-letter fingerprint on the row so the BULK
-- replay SQL paths (requestReplayAllUnresolved / requestBulkReplay /
-- requestInvestigationReplayAll) and REST /api/v1/replays can anti-join
-- dead_letter_mutes. Without this column a fresh deploy (CI/staging) bootstrapped
-- from schema.sql alone throws "column fingerprint does not exist" on every bulk
-- or single-row replay. Idempotent — safe against live DBs already migrated.
ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS fingerprint text;
CREATE INDEX IF NOT EXISTS dead_letters_workspace_fingerprint_unresolved_idx
  ON dead_letters (workspace_id, fingerprint)
  WHERE resolved_at IS NULL;

-- AXE-57: dead-letter fingerprint mutes — operators silence "all DLs
-- that look like X" during a known outage without losing the
-- per-event records. Fingerprint is opaque text built in app code.
CREATE TABLE IF NOT EXISTS dead_letter_mutes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  reason text,
  until timestamptz,
  muted_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dead_letter_mutes_workspace_fingerprint_idx
  ON dead_letter_mutes (workspace_id, fingerprint);

-- Billing & payments (migration 0037). See axelapp.ai/pricing for the
-- model. Postgres owns plan identity, period counters, and the
-- Stripe webhook journal; Stripe owns cards/dunning/invoice rendering.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'enterprise'));
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_stripe_customer_unique'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_stripe_customer_unique UNIQUE (stripe_customer_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_stripe_subscription_unique'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_stripe_subscription_unique UNIQUE (stripe_subscription_id);
  END IF;
END $$;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'ok'
    CHECK (billing_status IN ('ok', 'past_due', 'grace', 'suspended', 'canceled'));
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_period_start timestamptz;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_period_end timestamptz;

CREATE INDEX IF NOT EXISTS workspaces_plan_idx
  ON workspaces (plan) WHERE plan <> 'free';
CREATE INDEX IF NOT EXISTS workspaces_billing_status_idx
  ON workspaces (billing_status) WHERE billing_status <> 'ok';

CREATE TABLE IF NOT EXISTS workspace_usage_period (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  ingest_tasks bigint NOT NULL DEFAULT 0 CHECK (ingest_tasks >= 0),
  delivery_tasks bigint NOT NULL DEFAULT 0 CHECK (delivery_tasks >= 0),
  -- Billing and quota are inbound-only; delivery_tasks remains operational telemetry.
  total_tasks bigint GENERATED ALWAYS AS (ingest_tasks) STORED,
  reported_to_stripe_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, period_start)
);

CREATE INDEX IF NOT EXISTS workspace_usage_period_period_idx
  ON workspace_usage_period (period_start DESC);
CREATE INDEX IF NOT EXISTS workspace_usage_period_unreported_idx
  ON workspace_usage_period (workspace_id, period_start)
  WHERE reported_to_stripe_at IS NULL;

CREATE TABLE IF NOT EXISTS billing_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);

CREATE INDEX IF NOT EXISTS billing_events_workspace_time_idx
  ON billing_events (workspace_id, received_at DESC);
CREATE INDEX IF NOT EXISTS billing_events_type_time_idx
  ON billing_events (type, received_at DESC);
CREATE INDEX IF NOT EXISTS billing_events_unprocessed_idx
  ON billing_events (received_at)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS billing_invoices (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL,
  total_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  task_count bigint,
  period_start timestamptz,
  period_end timestamptz,
  hosted_url text,
  pdf_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_invoices_workspace_time_idx
  ON billing_invoices (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_invoices_status_idx
  ON billing_invoices (status, created_at DESC)
  WHERE status IN ('open', 'past_due', 'uncollectible');
