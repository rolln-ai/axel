-- Migration 0007: route engine column (AXE-46).
--
-- Tags each route with how its filter_expression / transform_script should
-- be evaluated:
--   - 'legacy_js'    — JS that requires the Node Worker-Threads sandbox.
--                       Default for existing rows. Edge router still
--                       dead-letters these (no eval in CF Workers); they
--                       only run via the Node router.
--   - 'declarative'  — JSON declarations of the route engine DSL in
--                       packages/shared/src/route-engine.ts. The edge
--                       router executes them inline. Event-Maps-generated
--                       routes use this engine.

ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'legacy_js'
    CHECK (engine IN ('legacy_js', 'declarative'));

-- Partial index for the hot path: edge router only cares about declarative
-- routes attached to a specific (workspace, source).
CREATE INDEX IF NOT EXISTS routes_declarative_active_idx
  ON routes (workspace_id, source_id)
  WHERE engine = 'declarative' AND status = 'active';
