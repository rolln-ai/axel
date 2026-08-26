-- Migration 0006: Event Maps — Axel's AI-native event understanding layer.
-- Parent epic AXE-22, this slice AXE-40.
--
-- An Event Map is a durable, versioned contract describing what a source
-- emits and how it maps to a destination. Versions are immutable; the
-- event_maps row tracks the currently-active version. Raw payloads are NEVER
-- stored here — only references (event_id) back into ClickHouse/R2, which
-- remain the source of truth.

CREATE TABLE IF NOT EXISTS event_maps (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- Optional route attachment. An Event Map can exist source-level (no
  -- route) as a pure schema contract, or be bound to a route for activation.
  -- NULL = source-level; SET NULL on route delete so the schema survives.
  route_id text REFERENCES routes(id) ON DELETE SET NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  -- Points at event_map_versions.id. Kept as a plain text reference (no FK)
  -- to mirror the existing destinations.credentials_ref pattern and avoid
  -- the chicken-and-egg ordering issue when a map exists briefly before its
  -- first version is appended. Repository code is responsible for clearing
  -- this when the referenced version is deleted.
  current_version_id text,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_maps_workspace_source_idx
  ON event_maps (workspace_id, source_id);

CREATE INDEX IF NOT EXISTS event_maps_workspace_status_idx
  ON event_maps (workspace_id, status);

-- Per-workspace name uniqueness (same READ COMMITTED race rationale as
-- sources_workspace_lower_name_idx).
CREATE UNIQUE INDEX IF NOT EXISTS event_maps_workspace_lower_name_idx
  ON event_maps (workspace_id, lower(name));

-- Immutable versions. Each save creates a new row; never UPDATE inferred
-- schema or generated code on an existing version. This is the auditable
-- artifact that AXE-22 mandates (versioned code with author, model metadata,
-- prompt version, and fixture test results).
CREATE TABLE IF NOT EXISTS event_map_versions (
  id text PRIMARY KEY,
  event_map_id text NOT NULL REFERENCES event_maps(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  -- Inferred schema produced by AXE-42. Shape (subject to evolution, hence
  -- JSONB): { event_types, fields, ids, timestamps, status_fields,
  -- sensitive_fields, summary }.
  inferred_schema jsonb NOT NULL,
  -- Per-field user annotations: { "<path>": { ignored?: boolean,
  -- sensitive_override?: boolean } }.
  field_annotations jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Generated route artifacts (filled in by AXE-45). NULL before codegen.
  generated_filter text,
  generated_transform text,
  -- 'jsonata' is the planned default (AXE-46); 'js' for legacy/escape hatch.
  transform_language text
    CHECK (transform_language IN ('jsonata', 'js')),
  -- Destination mapping proposal (AXE-44). Shape varies by destination type.
  destination_mapping jsonb,
  -- Provenance: model id, prompt version, sample count, etc.
  model_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Fixture test results summary: { passed, failed, total, ran_at }.
  -- NULL until the activation gate (AXE-45) runs.
  fixture_results jsonb,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_map_id, version_number)
);

CREATE INDEX IF NOT EXISTS event_map_versions_map_created_idx
  ON event_map_versions (event_map_id, created_at DESC);

-- Per-version test fixtures (input + expected output). Synthetic fixtures
-- leave source_event_id NULL; otherwise this references a real event in
-- ClickHouse/R2 (loose text reference — those stores aren't in Postgres).
CREATE TABLE IF NOT EXISTS event_map_fixtures (
  id text PRIMARY KEY,
  event_map_version_id text NOT NULL
    REFERENCES event_map_versions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_event_id text,
  event_type text,
  input_payload jsonb NOT NULL,
  expected_output jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_map_fixtures_version_idx
  ON event_map_fixtures (event_map_version_id);

-- Drift records emitted by the drift detector (AXE-47). Resolved when a new
-- version of the Event Map accommodates the drift, or when explicitly
-- dismissed by a user.
CREATE TABLE IF NOT EXISTS event_map_drift_events (
  id bigserial PRIMARY KEY,
  event_map_id text NOT NULL REFERENCES event_maps(id) ON DELETE CASCADE,
  event_map_version_id text NOT NULL
    REFERENCES event_map_versions(id) ON DELETE CASCADE,
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

-- Hot lookup: unresolved drift per workspace+map, newest first. Partial
-- index so resolved history doesn't bloat the page-load query.
CREATE INDEX IF NOT EXISTS event_map_drift_events_unresolved_idx
  ON event_map_drift_events (workspace_id, event_map_id, observed_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS event_map_drift_events_workspace_time_idx
  ON event_map_drift_events (workspace_id, observed_at DESC);
