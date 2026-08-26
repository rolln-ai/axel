-- Migration 0035: per-route pipeline_graph (DAG) column.
--
-- Background: today a route carries a single `filter_expression` and a
-- single `transform_script`, applied uniformly before fan-out to every
-- attached destination. The new pipeline_graph lets a route describe a
-- DAG of filter/transform nodes that branches and fans into destinations
-- — enabling cases like
--   (a) source → transform A → destination X
--                          ↓
--                          destination Y         (fan-out at transform)
--   (b) source → transform A → destination X
--               → transform B → destination X    (two leaves into one dest)
-- The graph IR + validator + executor live in
-- packages/shared/src/route-engine.ts (`validatePipelineGraph`,
-- `executeGraph`). See that file for the safety contract.
--
-- Dual-mode by design: when `pipeline_graph IS NULL`, the router uses the
-- legacy single-filter/single-transform/uniform-fan-out path verbatim
-- (byte-equivalent semantics; existing delivery idempotency keys
-- unchanged). When non-NULL, the router walks the graph via executeGraph
-- and enqueues one delivery per leaf, with the leaf node id appended to
-- the idempotency key so two leaves into one destination don't dedupe.
--
-- No backfill in this migration. The wizard writes a `pipeline_graph` for
-- new routes from day one; existing routes stay on the legacy shape until
-- their owner opens the canvas and saves. The CHECK constraint prevents
-- the two shapes from coexisting on a single row so there is never
-- ambiguity about which engine runs.

ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS pipeline_graph jsonb NULL;

ALTER TABLE routes
  DROP CONSTRAINT IF EXISTS routes_pipeline_graph_excludes_legacy;

ALTER TABLE routes
  ADD CONSTRAINT routes_pipeline_graph_excludes_legacy
  CHECK (
    pipeline_graph IS NULL
    OR (filter_expression IS NULL AND transform_script IS NULL)
  );
