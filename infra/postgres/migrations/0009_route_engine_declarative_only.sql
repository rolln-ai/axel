-- Migration 0009: declarative route engine is now the only valid engine
-- for routes that carry a filter_expression or transform_script (AXE-24).
--
-- Background: migration 0007 added the `engine` column with values
-- `legacy_js` (eval'd JS in a Node sandbox) and `declarative` (eval-free
-- JSON DSL evaluated inline by the edge router). The Node sandbox was
-- never deployed in production — the live router is `apps/router-edge`
-- on Cloudflare Workers, which dead-letters legacy_js routes with
-- reason `sandbox_unavailable_in_edge_runtime`. The dashboard UI was
-- still selling filter/transform fields that quietly dead-lettered every
-- event.
--
-- This migration:
--   1. Disables every active route that carries a filter/transform but
--      isn't already declarative. The audit_log entry tells operators
--      what happened so they can re-author the route via Data Contracts
--      codegen (which already emits the declarative DSL).
--   2. Backfills passthrough routes (no filter / no transform) to
--      engine='declarative' so the column has a single canonical value
--      going forward.
--   3. Adds a CHECK constraint that prevents the broken state from
--      reappearing: any route with a filter_expression or
--      transform_script must use the declarative engine.
--
-- The 'legacy_js' string remains a legal value in the engine column
-- (no CHECK change) only so disabled rows from step 1 don't violate
-- their own constraint. New rows can still write either string, but
-- the new constraint blocks the broken combination.

-- Step 1: disable broken rows + leave a breadcrumb in audit_log so the
-- operator can find them. The metadata payload mirrors the shape used
-- by other route-related audit entries.
WITH disabled AS (
  UPDATE routes
     SET status = 'disabled',
         updated_at = now()
   WHERE status = 'active'
     AND engine <> 'declarative'
     AND (filter_expression IS NOT NULL OR transform_script IS NOT NULL)
  RETURNING id, workspace_id, engine, filter_expression, transform_script
)
INSERT INTO audit_log (workspace_id, actor_user_id, action, target_type, target_id, metadata)
SELECT
  d.workspace_id,
  NULL,
  'route.auto_disabled_legacy_engine',
  'route',
  d.id,
  jsonb_build_object(
    'reason', 'AXE-24 migration disabled this route because the legacy_js engine was never wired up in the production edge router. Recreate the route via Data Contracts codegen to get a declarative equivalent.',
    'previous_engine', d.engine,
    'had_filter', (d.filter_expression IS NOT NULL),
    'had_transform', (d.transform_script IS NOT NULL)
  )
FROM disabled d;

-- Step 2: passthrough routes have identical behavior under either
-- engine, so flip them all to 'declarative' to converge on one value.
UPDATE routes
   SET engine = 'declarative',
       updated_at = now()
 WHERE engine <> 'declarative'
   AND filter_expression IS NULL
   AND transform_script IS NULL;

-- Step 3: prevent the broken combination from being reintroduced. A
-- route with any filter or transform MUST use the declarative engine.
ALTER TABLE routes
  DROP CONSTRAINT IF EXISTS routes_filter_transform_declarative_only;

ALTER TABLE routes
  ADD CONSTRAINT routes_filter_transform_declarative_only
  CHECK (
    (filter_expression IS NULL AND transform_script IS NULL)
    OR engine = 'declarative'
  );

-- Step 4: change the column default so future inserts that omit
-- `engine` (e.g. tests) get the safe value. Existing rows are
-- unaffected by a default change.
ALTER TABLE routes
  ALTER COLUMN engine SET DEFAULT 'declarative';
