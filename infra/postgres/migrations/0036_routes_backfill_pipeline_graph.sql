-- Migration 0036: backfill legacy routes to the pipeline_graph shape.
--
-- Migration 0035 introduced the pipeline_graph column + dual-mode
-- router. The wizard (#162) and canvas (#161) write pipeline_graph for
-- new + edited routes, but pre-existing rows still carry the legacy
-- single-filter / single-transform shape. This migration converts
-- every such row to the equivalent pipeline_graph JSON so the schema
-- converges on one shape — dual-mode remains in place as a safety net
-- for any row that fails conversion.
--
-- Conversion rules (mirroring synthesizeLegacyGraph in the dashboard's
-- canvas/graphUtils.ts):
--   - 1 source node (id 'n_src')
--   - optional filter node (id 'n_f_legacy') when filter_expression is
--     non-null AND its kind isn't 'always'
--   - optional transform node (id 'n_t_legacy') when transform_script
--     is non-null AND its kind isn't 'passthrough'
--   - 1 destination node per route_destinations row, id
--     'n_dst_' || destination_id
--   - Edges: chain source → filter? → transform? → fan-out across
--     destinations.
--
-- Routes with zero route_destinations rows are skipped — they would
-- produce an invalid graph (graph_no_destinations) and the dual-mode
-- router handles them fine on the legacy path.
--
-- Re-runnable: the WHERE clause filters out rows that already have
-- pipeline_graph set, so applying twice is a no-op.

DO $$
DECLARE
  v_route record;
  v_nodes jsonb;
  v_edges jsonb;
  v_cursor text;
  v_dest_id text;
  v_dest_node_id text;
  v_filter jsonb;
  v_transform jsonb;
  v_filter_kind text;
  v_transform_kind text;
  v_converted integer := 0;
  v_skipped_no_dest integer := 0;
  v_skipped_invalid integer := 0;
BEGIN
  FOR v_route IN
    SELECT id, workspace_id, source_id, filter_expression, transform_script
      FROM routes
     WHERE pipeline_graph IS NULL
       AND (filter_expression IS NOT NULL OR transform_script IS NOT NULL)
  LOOP
    -- Skip routes with no attached destinations — graph would be invalid.
    IF NOT EXISTS (
      SELECT 1 FROM route_destinations WHERE route_id = v_route.id
    ) THEN
      v_skipped_no_dest := v_skipped_no_dest + 1;
      CONTINUE;
    END IF;

    BEGIN
      v_filter := CASE
        WHEN v_route.filter_expression IS NULL THEN NULL
        ELSE v_route.filter_expression::jsonb
      END;
      v_transform := CASE
        WHEN v_route.transform_script IS NULL THEN NULL
        ELSE v_route.transform_script::jsonb
      END;
    EXCEPTION WHEN others THEN
      -- Malformed JSON in the legacy columns — leave it alone.
      v_skipped_invalid := v_skipped_invalid + 1;
      CONTINUE;
    END;

    v_filter_kind := v_filter->>'kind';
    v_transform_kind := v_transform->>'kind';

    v_nodes := jsonb_build_array(
      jsonb_build_object('id', 'n_src', 'kind', 'source')
    );
    v_edges := '[]'::jsonb;
    v_cursor := 'n_src';

    -- Filter node (skip kind='always' — semantically passthrough)
    IF v_filter IS NOT NULL AND v_filter_kind IS DISTINCT FROM 'always' THEN
      v_nodes := v_nodes || jsonb_build_array(
        jsonb_build_object(
          'id', 'n_f_legacy',
          'kind', 'filter',
          'filter', v_filter
        )
      );
      v_edges := v_edges || jsonb_build_array(
        jsonb_build_object('from', v_cursor, 'to', 'n_f_legacy')
      );
      v_cursor := 'n_f_legacy';
    END IF;

    -- Transform node (skip kind='passthrough' — semantically no-op)
    IF v_transform IS NOT NULL AND v_transform_kind IS DISTINCT FROM 'passthrough' THEN
      v_nodes := v_nodes || jsonb_build_array(
        jsonb_build_object(
          'id', 'n_t_legacy',
          'kind', 'transform',
          'transform', v_transform
        )
      );
      v_edges := v_edges || jsonb_build_array(
        jsonb_build_object('from', v_cursor, 'to', 'n_t_legacy')
      );
      v_cursor := 'n_t_legacy';
    END IF;

    -- Destination nodes — one per route_destinations row, ordered by id
    -- so the resulting graph is deterministic.
    FOR v_dest_id IN
      SELECT destination_id
        FROM route_destinations
       WHERE route_id = v_route.id
       ORDER BY destination_id
    LOOP
      v_dest_node_id := 'n_dst_' || v_dest_id;
      v_nodes := v_nodes || jsonb_build_array(
        jsonb_build_object(
          'id', v_dest_node_id,
          'kind', 'destination',
          'destination_id', v_dest_id
        )
      );
      v_edges := v_edges || jsonb_build_array(
        jsonb_build_object('from', v_cursor, 'to', v_dest_node_id)
      );
    END LOOP;

    -- Apply: set pipeline_graph + clear legacy columns in one UPDATE so
    -- the CHECK constraint (pipeline_graph excludes legacy) is satisfied.
    UPDATE routes
       SET pipeline_graph = jsonb_build_object(
             'version', 1,
             'nodes', v_nodes,
             'edges', v_edges
           ),
           filter_expression = NULL,
           transform_script = NULL,
           updated_at = now()
     WHERE id = v_route.id;

    v_converted := v_converted + 1;
  END LOOP;

  RAISE NOTICE 'Migration 0036: converted % legacy route(s) to pipeline_graph; skipped % with no destinations and % with malformed JSON',
    v_converted, v_skipped_no_dest, v_skipped_invalid;
END$$;
