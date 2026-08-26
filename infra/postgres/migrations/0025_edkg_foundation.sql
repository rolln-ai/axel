-- Migration 0025: EDKG (Enterprise Data Knowledge Graph) foundation.
--
-- Creates the persistent graph + wiki + provenance store. Every assertion
-- the system makes lives here and must be traceable to a raw source via
-- edkg_provenance. The graph is workspace-scoped (multi-tenant) and
-- intended to coexist with the existing control plane (workspaces, sources,
-- destinations, data_contracts, routes), which it ingests as its first
-- source of knowledge.
--
-- This migration is structural only. No agent runs are kicked off and no
-- existing tables are modified. Backfill is gated on a per-workspace
-- EDKG_ENABLED flag introduced in a later migration.
--
-- Companion human-readable spec: packages/edkg-schema/SCHEMA.md
-- Ontology version constant: packages/edkg-schema/src/ontology.ts
--
-- Extensions ------------------------------------------------------------------
-- pgvector for embeddings (kNN retrieval).
-- pg_trgm for fuzzy slug / name matching during retrieval.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Nodes -----------------------------------------------------------------------
-- entity_type is constrained by application code against the enum in
-- packages/edkg-schema/src/ontology.ts. We deliberately keep it as TEXT
-- + CHECK so the ontology can be extended without a DB migration each time.

CREATE TABLE IF NOT EXISTS edkg_nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  properties      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sensitivity     TEXT NOT NULL DEFAULT 'internal'
                    CHECK (sensitivity IN ('public', 'internal', 'restricted', 'secret')),
  confidence      REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  ontology_version TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS edkg_nodes_workspace_type_slug_uniq
  ON edkg_nodes (workspace_id, entity_type, slug)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS edkg_nodes_workspace_type_idx
  ON edkg_nodes (workspace_id, entity_type);
CREATE INDEX IF NOT EXISTS edkg_nodes_properties_gin
  ON edkg_nodes USING GIN (properties);
CREATE INDEX IF NOT EXISTS edkg_nodes_name_trgm
  ON edkg_nodes USING GIN (name gin_trgm_ops);

-- Edges -----------------------------------------------------------------------
-- Directed. (from, to, relation_type) is unique to keep upserts idempotent.

CREATE TABLE IF NOT EXISTS edkg_edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_node_id    UUID NOT NULL REFERENCES edkg_nodes(id) ON DELETE CASCADE,
  to_node_id      UUID NOT NULL REFERENCES edkg_nodes(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,
  properties      JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence      REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  usage_weight    REAL NOT NULL DEFAULT 0,
  ontology_version TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS edkg_edges_triple_uniq
  ON edkg_edges (workspace_id, from_node_id, to_node_id, relation_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS edkg_edges_from_idx ON edkg_edges (from_node_id, relation_type);
CREATE INDEX IF NOT EXISTS edkg_edges_to_idx ON edkg_edges (to_node_id, relation_type);
CREATE INDEX IF NOT EXISTS edkg_edges_workspace_idx ON edkg_edges (workspace_id);

-- Pages -----------------------------------------------------------------------
-- One wiki page per node. body is markdown. Tracked separately from
-- edkg_nodes so we can iterate page content without rewriting node rows.

CREATE TABLE IF NOT EXISTS edkg_pages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id             UUID NOT NULL UNIQUE REFERENCES edkg_nodes(id) ON DELETE CASCADE,
  slug                TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',
  frontmatter         JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_version_id  UUID,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'needs_review', 'archived')),
  body_tsv            tsvector,
  ontology_version    TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS edkg_pages_workspace_slug_uniq
  ON edkg_pages (workspace_id, slug);
CREATE INDEX IF NOT EXISTS edkg_pages_body_tsv_idx
  ON edkg_pages USING GIN (body_tsv);
CREATE INDEX IF NOT EXISTS edkg_pages_title_trgm
  ON edkg_pages USING GIN (title gin_trgm_ops);

CREATE OR REPLACE FUNCTION edkg_pages_body_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.body_tsv :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.body, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS edkg_pages_body_tsv_trg ON edkg_pages;
CREATE TRIGGER edkg_pages_body_tsv_trg
  BEFORE INSERT OR UPDATE OF title, body ON edkg_pages
  FOR EACH ROW EXECUTE FUNCTION edkg_pages_body_tsv_update();

-- Page versions ---------------------------------------------------------------
-- Append-only. current_version_id on edkg_pages points at the newest row here.

CREATE TABLE IF NOT EXISTS edkg_page_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES edkg_pages(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  frontmatter     JSONB NOT NULL,
  diff            TEXT,
  agent_run_id    UUID,
  author_kind     TEXT NOT NULL CHECK (author_kind IN ('agent', 'human', 'system')),
  author_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS edkg_page_versions_page_idx
  ON edkg_page_versions (page_id, created_at DESC);

-- Provenance ------------------------------------------------------------------
-- Required for every assertion. target is polymorphic: node, edge, or
-- page_version. source_kind identifies the raw artifact type (e.g.,
-- 'axel.source', 'axel.data_contract', 'axel.audit_log', 'snowflake.table',
-- 'dbt.manifest', 'github.repo', 'human.edit'). source_ref is opaque and
-- agent-specific (typically an URL or a {table, pk} JSON).

CREATE TABLE IF NOT EXISTS edkg_provenance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('node', 'edge', 'page_version')),
  target_id       UUID NOT NULL,
  source_kind     TEXT NOT NULL,
  source_ref      JSONB NOT NULL,
  excerpt         TEXT,
  authority       REAL NOT NULL DEFAULT 0.5 CHECK (authority >= 0 AND authority <= 1),
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agent_run_id    UUID
);

CREATE INDEX IF NOT EXISTS edkg_provenance_target_idx
  ON edkg_provenance (target_kind, target_id);
CREATE INDEX IF NOT EXISTS edkg_provenance_workspace_kind_idx
  ON edkg_provenance (workspace_id, source_kind);

-- Action log ------------------------------------------------------------------
-- Append-only system action log: every agent run, every upsert decision,
-- every human approval. Distinct from existing audit_log; that one is for
-- workspace-user actions, this one is for EDKG-internal events.

CREATE TABLE IF NOT EXISTS edkg_action_log (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human', 'system')),
  actor_ref       TEXT,
  target_kind     TEXT,
  target_id       UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS edkg_action_log_workspace_created_idx
  ON edkg_action_log (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS edkg_action_log_action_idx
  ON edkg_action_log (action);

-- Lint findings ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edkg_lint_findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('node', 'edge', 'page')),
  target_id       UUID NOT NULL,
  description     TEXT NOT NULL,
  suggested_fix   JSONB,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'acknowledged', 'fixed', 'wontfix')),
  resolved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  agent_run_id    UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS edkg_lint_findings_workspace_status_idx
  ON edkg_lint_findings (workspace_id, status, severity);
CREATE INDEX IF NOT EXISTS edkg_lint_findings_target_idx
  ON edkg_lint_findings (target_kind, target_id);

-- Agent runs ------------------------------------------------------------------
-- One row per LLM call. cost_usd is computed in code from model + tokens.

CREATE TABLE IF NOT EXISTS edkg_agent_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent             TEXT NOT NULL,
  model             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('pending', 'running', 'succeeded', 'failed',
                       'rejected_ungrounded', 'rejected_invalid_output')),
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cost_usd          NUMERIC(12, 6),
  latency_ms        INTEGER,
  prompt_hash       TEXT,
  output            JSONB,
  error             TEXT,
  job_id            UUID,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS edkg_agent_runs_workspace_started_idx
  ON edkg_agent_runs (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS edkg_agent_runs_agent_status_idx
  ON edkg_agent_runs (agent, status);

-- Embeddings ------------------------------------------------------------------
-- pgvector. Dimension matches OpenRouter-hosted embedding model
-- (text-embedding-3-small / 1536-d). target is polymorphic to allow embedding
-- node summaries or full page bodies independently.

CREATE TABLE IF NOT EXISTS edkg_embeddings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('node', 'page')),
  target_id       UUID NOT NULL,
  model           TEXT NOT NULL,
  dim             INTEGER NOT NULL,
  embedding       vector(1536),
  content_hash    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS edkg_embeddings_target_model_uniq
  ON edkg_embeddings (target_kind, target_id, model);
CREATE INDEX IF NOT EXISTS edkg_embeddings_workspace_idx
  ON edkg_embeddings (workspace_id);
-- ivfflat index added once we have enough rows; until then sequential scan
-- on a workspace-bounded set is fine. Statement kept as a comment so the
-- ops runbook lists the migration sequence:
--   CREATE INDEX edkg_embeddings_ivf ON edkg_embeddings
--     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Job queue -------------------------------------------------------------------
-- Drives apps/edkg-worker. Worker uses SELECT ... FOR UPDATE SKIP LOCKED
-- to claim jobs.

CREATE TABLE IF NOT EXISTS edkg_job_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  run_after       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error      TEXT,
  claimed_by      TEXT,
  claimed_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS edkg_job_queue_claim_idx
  ON edkg_job_queue (status, run_after)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS edkg_job_queue_workspace_idx
  ON edkg_job_queue (workspace_id, status);

-- Source cursors --------------------------------------------------------------
-- Per (workspace, source_kind) high-water mark for incremental ingestion.

CREATE TABLE IF NOT EXISTS edkg_source_cursors (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind     TEXT NOT NULL,
  cursor          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, source_kind)
);
