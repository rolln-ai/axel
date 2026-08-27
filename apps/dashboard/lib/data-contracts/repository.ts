import "server-only";
import type pg from "pg";
import {
  validatePipelineGraph,
  type GeneratedFilter,
  type GeneratedTransform,
  type PipelineEdge,
  type PipelineGraph,
  type PipelineNode,
} from "@axel/shared";
import type { Queryable } from "../db";
import { db, withTransaction } from "../db";
import { prefixedId } from "../ids";
import {
  generalizeFixturePayload,
  sanitizeDestinationMappingForPersistence,
  sanitizeDriftDetailForPersistence,
  sanitizeFixtureResultsForPersistence,
  sanitizeInferredSchemaForPersistence,
  sanitizeModelMetadataForPersistence,
} from "./persistence-sanitizer";

/**
 * Run inside an existing transaction
 * client when one is supplied, otherwise open a fresh transaction. Also lets
 * tests inject a fake client without needing a real Pool.
 */
async function maybeWithTransaction<T>(
  client: pg.PoolClient | undefined,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return client ? fn(client) : withTransaction(fn);
}

export type DataContractStatus = "draft" | "active" | "archived";
export type TransformLanguage = "jsonata" | "js";
export type DriftCategory =
  | "new_event_type"
  | "missing_field"
  | "type_change"
  | "new_sensitive_field"
  | "unknown_shape";

export interface DataContractRow {
  id: string;
  workspace_id: string;
  source_id: string;
  route_id: string | null;
  name: string;
  status: DataContractStatus;
  current_version_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DataContractVersionRow {
  id: string;
  data_contract_id: string;
  workspace_id: string;
  version_number: number;
  inferred_schema: unknown;
  field_annotations: unknown;
  generated_filter: string | null;
  generated_transform: string | null;
  transform_language: TransformLanguage | null;
  destination_mapping: unknown;
  model_metadata: unknown;
  fixture_results: unknown;
  created_by_user_id: string | null;
  created_at: string;
}

export interface DataContractFixtureRow {
  id: string;
  data_contract_version_id: string;
  workspace_id: string;
  source_event_id: string | null;
  event_type: string | null;
  input_payload: unknown;
  expected_output: unknown;
  created_at: string;
}

export interface DataContractDriftRow {
  id: string;
  data_contract_id: string;
  data_contract_version_id: string;
  workspace_id: string;
  category: DriftCategory;
  field_path: string | null;
  detail: unknown;
  sample_event_id: string | null;
  observed_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
}

export interface CreateDataContractInput {
  workspaceId: string;
  sourceId: string;
  routeId?: string | null;
  name: string;
  createdByUserId?: string | null;
}

export interface AppendVersionInput {
  dataContractId: string;
  workspaceId: string;
  inferredSchema: unknown;
  fieldAnnotations?: unknown;
  generatedFilter?: string | null;
  generatedTransform?: string | null;
  transformLanguage?: TransformLanguage | null;
  destinationMapping?: unknown;
  modelMetadata?: unknown;
  fixtureResults?: unknown;
  createdByUserId?: string | null;
}

export interface InsertFixtureInput {
  dataContractVersionId: string;
  workspaceId: string;
  sourceEventId?: string | null;
  eventType?: string | null;
  inputPayload: unknown;
  expectedOutput: unknown;
}

export interface InsertDriftInput {
  dataContractId: string;
  dataContractVersionId: string;
  workspaceId: string;
  category: DriftCategory;
  fieldPath?: string | null;
  detail?: unknown;
  sampleEventId?: string | null;
}

const EVENT_MAP_COLUMNS = `id, workspace_id, source_id, route_id, name, status,
  current_version_id, created_by_user_id, created_at::text, updated_at::text`;

const EVENT_MAP_VERSION_COLUMNS = `id, data_contract_id, workspace_id, version_number,
  inferred_schema, field_annotations, generated_filter, generated_transform,
  transform_language, destination_mapping, model_metadata, fixture_results,
  created_by_user_id, created_at::text`;

const FIXTURE_COLUMNS = `id, data_contract_version_id, workspace_id, source_event_id,
  event_type, input_payload, expected_output, created_at::text`;

const DRIFT_COLUMNS = `id::text, data_contract_id, data_contract_version_id, workspace_id,
  category, field_path, detail, sample_event_id,
  observed_at::text, resolved_at::text, resolved_by_user_id`;

export async function createDataContract(
  input: CreateDataContractInput,
  client: Queryable = db(),
): Promise<DataContractRow> {
  const id = prefixedId("em");
  const result = await client.query<DataContractRow>(
    `INSERT INTO data_contracts (id, workspace_id, source_id, route_id, name,
                             status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6)
     RETURNING ${EVENT_MAP_COLUMNS}`,
    [
      id,
      input.workspaceId,
      input.sourceId,
      input.routeId ?? null,
      input.name,
      input.createdByUserId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createDataContract: insert returned no row");
  return row;
}

export async function getDataContract(
  id: string,
  workspaceId: string,
  client: Queryable = db(),
): Promise<DataContractRow | null> {
  const result = await client.query<DataContractRow>(
    `SELECT ${EVENT_MAP_COLUMNS}
       FROM data_contracts
      WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function listDataContractsForSource(
  workspaceId: string,
  sourceId: string,
  client: Queryable = db(),
): Promise<DataContractRow[]> {
  const result = await client.query<DataContractRow>(
    `SELECT ${EVENT_MAP_COLUMNS}
       FROM data_contracts
      WHERE workspace_id = $1 AND source_id = $2
      ORDER BY created_at DESC`,
    [workspaceId, sourceId],
  );
  return result.rows;
}

export async function listDataContractsForWorkspace(
  workspaceId: string,
  client: Queryable = db(),
): Promise<DataContractRow[]> {
  const result = await client.query<DataContractRow>(
    `SELECT ${EVENT_MAP_COLUMNS}
       FROM data_contracts
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [workspaceId],
  );
  return result.rows;
}

/**
 * List every drift-watched Data Contract with a current version across ALL
 * workspaces. Cron-scoped — the drift detection + auto-extend job iterates
 * this list.
 *
 * Includes BOTH `active` and `draft` maps. Drafts used to be excluded, which
 * meant a contract inferred from a brand-new source (a handful of events, a
 * couple of event types) froze at that snapshot forever — the cron never
 * re-sampled it, so the long tail of event types that arrived later never
 * showed up until someone manually clicked "Refresh now". Watching drafts
 * lets auto-extend keep them current as traffic accumulates. Archived /
 * version-less maps are still skipped (nothing to watch).
 */
export async function listAllDriftWatchedDataContracts(
  client: Queryable = db(),
): Promise<DataContractRow[]> {
  const result = await client.query<DataContractRow>(
    `SELECT ${EVENT_MAP_COLUMNS}
       FROM data_contracts
      WHERE status IN ('active', 'draft')
        AND current_version_id IS NOT NULL
      ORDER BY workspace_id, updated_at DESC
      LIMIT 2000`,
  );
  return result.rows;
}

export interface SourceWithoutDataContractRow {
  source_id: string;
  workspace_id: string;
  name: string;
  created_at: string;
}

/**
 * List every webhook source across the platform that does NOT already
 * have a Data Contract. Cron-scoped — the auto-draft job uses this to find
 * candidates to seed a draft contract for.
 *
 * Filters:
 *   - status = 'active' (don't pre-create maps for disabled sources;
 *     they won't be emitting anything anyway).
 *   - NOT EXISTS in data_contracts (skip sources the user already has a
 *     map for, regardless of that map's status — even archived/deleted
 *     would be visible if the row existed, but cascade delete on
 *     data_contracts means this NOT EXISTS is accurate).
 *
 * Hard-capped per run so a workspace with thousands of inactive sources
 * can't blow up sampling cost.
 */
/**
 * Look up the active Data Contract (and its current version) for a given
 * source — if any. Used by the "Investigate failure" affordance on
 * dead-letter rows: a route's failure is only Event-Map-investigatable
 * when there's an active contract for the source.
 *
 * Returns null when no active map exists OR when the current_version_id
 * dangles (shouldn't happen in steady state, but defensive).
 */
export async function findActiveDataContractForSource(
  workspaceId: string,
  sourceId: string,
  client: Queryable = db(),
): Promise<{ map: DataContractRow; version: DataContractVersionRow } | null> {
  const mapResult = await client.query<DataContractRow>(
    `SELECT ${EVENT_MAP_COLUMNS}
       FROM data_contracts
      WHERE workspace_id = $1
        AND source_id = $2
        AND status = 'active'
        AND current_version_id IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [workspaceId, sourceId],
  );
  const map = mapResult.rows[0];
  if (!map || !map.current_version_id) return null;
  const versionResult = await client.query<DataContractVersionRow>(
    `SELECT ${EVENT_MAP_VERSION_COLUMNS}
       FROM data_contract_versions
      WHERE id = $1 AND workspace_id = $2`,
    [map.current_version_id, workspaceId],
  );
  const version = versionResult.rows[0];
  if (!version) return null;
  return { map, version };
}

export async function listSourcesWithoutDataContract(
  client: Queryable = db(),
): Promise<SourceWithoutDataContractRow[]> {
  const result = await client.query<SourceWithoutDataContractRow>(
    `SELECT s.id::text     AS source_id,
            s.workspace_id::text AS workspace_id,
            s.name,
            s.created_at::text
       FROM sources s
      WHERE s.status = 'active'
        AND NOT EXISTS (
          SELECT 1
            FROM data_contracts em
           WHERE em.workspace_id = s.workspace_id
             AND em.source_id = s.id
        )
      ORDER BY s.created_at DESC
      LIMIT 500`,
  );
  return result.rows;
}

export async function updateDataContractStatus(
  id: string,
  workspaceId: string,
  status: DataContractStatus,
  client: Queryable = db(),
): Promise<void> {
  await client.query(
    `UPDATE data_contracts
        SET status = $3, updated_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId, status],
  );
}

/**
 * Hard delete a Data Contract and everything attached to it.
 *
 * FK cascades in migration 0006 take care of:
 *   - data_contract_versions       (ON DELETE CASCADE on data_contract_id)
 *   - data_contract_fixtures       (ON DELETE CASCADE on data_contract_version_id)
 *   - data_contract_drift_events   (ON DELETE CASCADE on data_contract_id)
 *
 * Returns true when a row matched and was deleted, false when nothing
 * matched (already deleted, or wrong workspace) — callers use that to
 * distinguish 404 from success.
 */
export async function deleteDataContract(
  id: string,
  workspaceId: string,
  client: Queryable = db(),
): Promise<boolean> {
  const result = await client.query(
    `DELETE FROM data_contracts WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Append a new immutable version to a Data Contract and atomically point the
 * parent row at it. Wrapped in a transaction so a reader never sees an
 * data_contract.current_version_id that references a version row that doesn't
 * exist yet.
 */
export async function appendDataContractVersion(
  input: AppendVersionInput,
  txClient?: pg.PoolClient,
): Promise<DataContractVersionRow> {
  return maybeWithTransaction(txClient, async (client) => {
    // Serialize concurrent appends to the SAME Data Contract. version_number is
    // allocated via SELECT MAX+1 below, and data_contract_versions carries a
    // UNIQUE (data_contract_id, version_number) constraint — under READ
    // COMMITTED two racing appends (page auto-refresh vs. the manual "Refresh
    // now" button vs. the 5-minute drift cron's auto-extend) can both read the
    // same next_number and the loser blows up with a unique violation. Same
    // pattern as approvePatch in explain.ts; pg advisory xact locks are
    // reentrant per session, so callers that already hold this lock (e.g.
    // approvePatch passing its txClient through) are unaffected. Released
    // automatically on commit/rollback.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      input.dataContractId,
    ]);
    const next = await client.query<{ next_number: number | null }>(
      `SELECT CASE WHEN COUNT(em.id) = 0 THEN NULL
                   ELSE COALESCE(MAX(emv.version_number), 0) + 1
              END AS next_number
         FROM data_contracts em
         LEFT JOIN data_contract_versions emv
           ON emv.data_contract_id = em.id
          AND emv.workspace_id = em.workspace_id
        WHERE em.id = $1 AND em.workspace_id = $2`,
      [input.dataContractId, input.workspaceId],
    );
    const versionNumber = next.rows[0]?.next_number;
    if (versionNumber == null) {
      throw new Error("appendDataContractVersion: data contract not found in workspace");
    }
    const id = prefixedId("emv");
    const persistedSchema = sanitizeInferredSchemaForPersistence(
      input.inferredSchema,
    );
    const persistedMapping = sanitizeDestinationMappingForPersistence(
      input.destinationMapping,
    );
    const persistedFixtureResults = sanitizeFixtureResultsForPersistence(
      input.fixtureResults,
    );
    const persistedModelMetadata = sanitizeModelMetadataForPersistence(
      input.modelMetadata,
    );
    const inserted = await client.query<DataContractVersionRow>(
      `INSERT INTO data_contract_versions (
         id, data_contract_id, workspace_id, version_number, inferred_schema,
         field_annotations, generated_filter, generated_transform,
         transform_language, destination_mapping, model_metadata,
         fixture_results, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5::jsonb,
                 COALESCE($6::jsonb, '{}'::jsonb), $7, $8,
                 $9, $10::jsonb, COALESCE($11::jsonb, '{}'::jsonb),
                 $12::jsonb, $13)
       RETURNING ${EVENT_MAP_VERSION_COLUMNS}`,
      [
        id,
        input.dataContractId,
        input.workspaceId,
        versionNumber,
        JSON.stringify(persistedSchema),
        input.fieldAnnotations === undefined
          ? null
          : JSON.stringify(input.fieldAnnotations),
        input.generatedFilter ?? null,
        input.generatedTransform ?? null,
        input.transformLanguage ?? null,
        input.destinationMapping == null
          ? null
          : JSON.stringify(persistedMapping),
        input.modelMetadata === undefined
          ? null
          : JSON.stringify(persistedModelMetadata),
        input.fixtureResults == null
          ? null
          : JSON.stringify(persistedFixtureResults),
        input.createdByUserId ?? null,
      ],
    );
    const versionRow = inserted.rows[0];
    if (!versionRow) {
      throw new Error("appendDataContractVersion: insert returned no row");
    }
    await client.query(
      `UPDATE data_contracts
          SET current_version_id = $3, updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [input.dataContractId, input.workspaceId, versionRow.id],
    );
    return versionRow;
  });
}

// ---------------------------------------------------------------------------
// Route re-materialization (approve-patch -> live route resync)
// ---------------------------------------------------------------------------
//
// A Data Contract route carries its transform/filter as *data* — there is no
// runtime version lookup in the edge engine. `attachToRouteAction` bakes the
// codegen artifacts into the route at creation time (legacy
// filter_expression + transform_script columns, which migration 0036 / the
// canvas later converge onto an equivalent `pipeline_graph`). So when
// approvePatch appends a corrected version, nothing pushes the new transform
// into the live route and a replay re-fails identically. `resyncRouteToArtifacts`
// closes that gap: it re-materializes the patched filter/transform into the
// route, reusing the *same* graph shape codegen/0036 produce.
//
// Canonical codegen graph shape (mirrors synthesizeLegacyGraph in
// canvas/graphUtils.ts and migration 0036):
//   n_src (source)
//     -> [n_f_legacy (filter)]?     (omitted when filter.kind === 'always')
//       -> [n_t_legacy (transform)]? (omitted when transform.kind === 'passthrough')
//         -> n_dst_<id> (one per attached destination, fan-out)
//
// Routes whose pipeline_graph diverges from this single-chain shape (operator
// hand-edited the canvas: extra transforms, branching, renamed chain nodes,
// etc.) are NOT clobbered — they're skipped and reported so the patch never
// silently overwrites a bespoke pipeline.

const RESYNC_SOURCE_NODE_ID = "n_src";
const RESYNC_FILTER_NODE_ID = "n_f_legacy";
const RESYNC_TRANSFORM_NODE_ID = "n_t_legacy";
const RESYNC_DESTINATION_NODE_PREFIX = "n_dst_";

export type RouteResyncOutcome =
  | "updated_legacy"
  | "updated_graph"
  | "skipped_not_found"
  | "skipped_no_destinations"
  | "skipped_hand_edited"
  | "skipped_unparseable_graph";

export interface RouteResyncResult {
  route_id: string;
  outcome: RouteResyncOutcome;
}

interface RouteResyncRow {
  id: string;
  pipeline_graph: string | null;
  filter_expression: string | null;
  transform_script: string | null;
}

/**
 * Build the canonical codegen pipeline_graph for a route from the patched
 * filter + transform + its attached destinations. Identical node ids /
 * chaining to migration 0036 and synthesizeLegacyGraph so we never introduce
 * a divergent graph shape. `ui` positions from the prior graph are preserved
 * for any node id that still exists.
 */
function buildCanonicalGraph(
  filter: GeneratedFilter,
  transform: GeneratedTransform,
  destinationIds: string[],
  priorUi: PipelineGraph["ui"],
): PipelineGraph {
  const nodes: PipelineNode[] = [{ id: RESYNC_SOURCE_NODE_ID, kind: "source" }];
  const edges: PipelineEdge[] = [];
  let cursor = RESYNC_SOURCE_NODE_ID;

  if (filter.kind !== "always") {
    nodes.push({ id: RESYNC_FILTER_NODE_ID, kind: "filter", filter });
    edges.push({ from: cursor, to: RESYNC_FILTER_NODE_ID });
    cursor = RESYNC_FILTER_NODE_ID;
  }
  if (transform.kind !== "passthrough") {
    nodes.push({ id: RESYNC_TRANSFORM_NODE_ID, kind: "transform", transform });
    edges.push({ from: cursor, to: RESYNC_TRANSFORM_NODE_ID });
    cursor = RESYNC_TRANSFORM_NODE_ID;
  }
  for (const destId of destinationIds) {
    const id = `${RESYNC_DESTINATION_NODE_PREFIX}${destId}`;
    nodes.push({ id, kind: "destination", destination_id: destId });
    edges.push({ from: cursor, to: id });
  }

  const ui: Record<string, { x: number; y: number }> = {};
  if (priorUi) {
    const ids = new Set(nodes.map((n) => n.id));
    for (const [k, v] of Object.entries(priorUi)) {
      if (ids.has(k)) ui[k] = v;
    }
  }
  return {
    version: 1,
    nodes,
    edges,
    ...(Object.keys(ui).length > 0 ? { ui } : {}),
  };
}

/**
 * Returns true when `graph` is in the canonical single-chain codegen shape
 * for the given attached destinations: exactly one source, at most one filter
 * node and one transform node (the legacy/codegen ids), the chain is strictly
 * linear up to a single fan-out to the destinations, and the destination set
 * matches the route's attached destinations exactly. Anything else means the
 * operator hand-edited the pipeline and we must not clobber it.
 */
function isCanonicalCodegenGraph(
  graph: PipelineGraph,
  attachedDestinationIds: Set<string>,
): boolean {
  const sources = graph.nodes.filter((n) => n.kind === "source");
  const filters = graph.nodes.filter((n) => n.kind === "filter");
  const transforms = graph.nodes.filter((n) => n.kind === "transform");
  const destinations = graph.nodes.filter((n) => n.kind === "destination");

  if (sources.length !== 1) return false;
  if (sources[0]!.id !== RESYNC_SOURCE_NODE_ID) return false;
  if (filters.length > 1 || transforms.length > 1) return false;
  if (filters.length === 1 && filters[0]!.id !== RESYNC_FILTER_NODE_ID) return false;
  if (transforms.length === 1 && transforms[0]!.id !== RESYNC_TRANSFORM_NODE_ID) {
    return false;
  }
  if (destinations.length === 0) return false;

  // Destination nodes must be exactly the canonical n_dst_<id> nodes, one per
  // attached destination — no more, no fewer.
  const destIds = new Set<string>();
  for (const d of destinations) {
    if (d.kind !== "destination") continue;
    if (d.id !== `${RESYNC_DESTINATION_NODE_PREFIX}${d.destination_id}`) return false;
    destIds.add(d.destination_id);
  }
  if (destIds.size !== attachedDestinationIds.size) return false;
  for (const id of attachedDestinationIds) {
    if (!destIds.has(id)) return false;
  }

  // Edge topology must be the canonical linear chain that fans out to the
  // destinations only at the final hop. Rebuild the expected edge set from the
  // same chain logic and require an exact match (order-independent).
  const chain: string[] = [RESYNC_SOURCE_NODE_ID];
  if (filters.length === 1) chain.push(RESYNC_FILTER_NODE_ID);
  if (transforms.length === 1) chain.push(RESYNC_TRANSFORM_NODE_ID);
  const tail = chain[chain.length - 1]!;
  const expectedEdges = new Set<string>();
  for (let i = 0; i < chain.length - 1; i++) {
    expectedEdges.add(`${chain[i]}->${chain[i + 1]}`);
  }
  for (const d of destinations) {
    expectedEdges.add(`${tail}->${d.id}`);
  }
  if (graph.edges.length !== expectedEdges.size) return false;
  for (const e of graph.edges) {
    if (!expectedEdges.has(`${e.from}->${e.to}`)) return false;
  }
  return true;
}

/**
 * Re-materialize the patched filter + transform into a single live route,
 * inside the caller's transaction. The route is matched by id + workspace_id
 * only — the caller is responsible for passing route ids that genuinely belong
 * to the patched Data Contract (the replay-target routes). Returns a
 * structured outcome so the caller can audit/report skips without aborting the
 * whole approval.
 */
export async function resyncRouteToArtifacts(
  input: {
    routeId: string;
    workspaceId: string;
    filter: GeneratedFilter;
    transform: GeneratedTransform;
  },
  client: pg.PoolClient,
): Promise<RouteResyncResult> {
  const routeRes = await client.query<RouteResyncRow>(
    `SELECT id,
            pipeline_graph::text AS pipeline_graph,
            filter_expression,
            transform_script
       FROM routes
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE`,
    [input.routeId, input.workspaceId],
  );
  const route = routeRes.rows[0];
  if (!route) {
    return { route_id: input.routeId, outcome: "skipped_not_found" };
  }

  const filterJson = JSON.stringify(input.filter);
  const transformJson = JSON.stringify(input.transform);

  // Legacy single-shape route (pipeline_graph IS NULL): rewrite the
  // filter_expression / transform_script columns the dual-mode router reads.
  if (route.pipeline_graph === null) {
    await client.query(
      `UPDATE routes
          SET filter_expression = $3,
              transform_script = $4,
              updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [input.routeId, input.workspaceId, filterJson, transformJson],
    );
    return { route_id: input.routeId, outcome: "updated_legacy" };
  }

  // DAG route (pipeline_graph IS NOT NULL): only rewrite when the graph is
  // still in the canonical codegen shape. Load attached destinations first so
  // we can both validate the prior graph and rebuild the new one.
  const destsRes = await client.query<{ destination_id: string }>(
    `SELECT destination_id FROM route_destinations WHERE route_id = $1`,
    [input.routeId],
  );
  const attached = new Set(destsRes.rows.map((r) => r.destination_id));
  if (attached.size === 0) {
    // A graph with no destinations can't be valid; nothing safe to do.
    return { route_id: input.routeId, outcome: "skipped_no_destinations" };
  }

  let prior: PipelineGraph;
  try {
    prior = validatePipelineGraph(JSON.parse(route.pipeline_graph), {
      attached_destination_ids: attached,
      allow_duplicate_destination_nodes: true,
    });
  } catch {
    return { route_id: input.routeId, outcome: "skipped_unparseable_graph" };
  }

  if (!isCanonicalCodegenGraph(prior, attached)) {
    return { route_id: input.routeId, outcome: "skipped_hand_edited" };
  }

  const rebuilt = buildCanonicalGraph(
    input.filter,
    input.transform,
    // Preserve the prior graph's destination ordering (it equals the attached
    // set; this keeps deterministic node order on rewrite).
    prior.nodes
      .filter((n): n is Extract<PipelineNode, { kind: "destination" }> => n.kind === "destination")
      .map((n) => n.destination_id),
    prior.ui,
  );
  // Re-validate the rebuilt graph against the same attached set before persist.
  const validated = validatePipelineGraph(rebuilt, {
    attached_destination_ids: attached,
  });
  await client.query(
    `UPDATE routes
        SET pipeline_graph = $3::jsonb,
            filter_expression = NULL,
            transform_script = NULL,
            updated_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [input.routeId, input.workspaceId, JSON.stringify(validated)],
  );
  return { route_id: input.routeId, outcome: "updated_graph" };
}

export async function listDataContractVersions(
  dataContractId: string,
  workspaceId: string,
  client: Queryable = db(),
): Promise<DataContractVersionRow[]> {
  const result = await client.query<DataContractVersionRow>(
    `SELECT ${EVENT_MAP_VERSION_COLUMNS}
       FROM data_contract_versions
      WHERE data_contract_id = $1 AND workspace_id = $2
      ORDER BY version_number DESC`,
    [dataContractId, workspaceId],
  );
  return result.rows;
}

export async function getDataContractVersion(
  id: string,
  workspaceId: string,
  client: Queryable = db(),
): Promise<DataContractVersionRow | null> {
  const result = await client.query<DataContractVersionRow>(
    `SELECT ${EVENT_MAP_VERSION_COLUMNS}
       FROM data_contract_versions
      WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function insertDataContractFixture(
  input: InsertFixtureInput,
  client: Queryable = db(),
): Promise<DataContractFixtureRow> {
  const id = prefixedId("emf");
  const inputPayload = generalizeFixturePayload(input.inputPayload);
  const expectedOutput = generalizeFixturePayload(input.expectedOutput);
  const result = await client.query<DataContractFixtureRow>(
    `INSERT INTO data_contract_fixtures (
       id, data_contract_version_id, workspace_id, source_event_id,
       event_type, input_payload, expected_output
     )
     SELECT $1, $2, $3, NULL, NULL, $4::jsonb, $5::jsonb
       FROM data_contract_versions
      WHERE id = $2 AND workspace_id = $3
     RETURNING ${FIXTURE_COLUMNS}`,
    [
      id,
      input.dataContractVersionId,
      input.workspaceId,
      JSON.stringify(inputPayload),
      JSON.stringify(expectedOutput),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("insertDataContractFixture: insert returned no row");
  return row;
}

export async function listDataContractFixtures(
  dataContractVersionId: string,
  workspaceId: string,
  client: Queryable = db(),
): Promise<DataContractFixtureRow[]> {
  const result = await client.query<DataContractFixtureRow>(
    `SELECT ${FIXTURE_COLUMNS}
       FROM data_contract_fixtures
      WHERE data_contract_version_id = $1 AND workspace_id = $2
      ORDER BY created_at ASC`,
    [dataContractVersionId, workspaceId],
  );
  return result.rows;
}

export async function insertDriftEvent(
  input: InsertDriftInput,
  client: Queryable = db(),
): Promise<DataContractDriftRow> {
  const persistedDetail = sanitizeDriftDetailForPersistence(
    input.category,
    input.detail,
  );
  const result = await client.query<DataContractDriftRow>(
    `INSERT INTO data_contract_drift_events (
       data_contract_id, data_contract_version_id, workspace_id, category,
       field_path, detail, sample_event_id
     )
     SELECT $1, $2, $3, $4, $5, $6::jsonb, NULL
       FROM data_contract_versions v
      WHERE v.id = $2
        AND v.data_contract_id = $1
        AND v.workspace_id = $3
     RETURNING ${DRIFT_COLUMNS}`,
    [
      input.dataContractId,
      input.dataContractVersionId,
      input.workspaceId,
      input.category,
      input.fieldPath ?? null,
      JSON.stringify(persistedDetail),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("insertDriftEvent: insert returned no row");
  return row;
}

export async function listUnresolvedDriftEvents(
  workspaceId: string,
  dataContractId: string,
  client: Queryable = db(),
): Promise<DataContractDriftRow[]> {
  const result = await client.query<DataContractDriftRow>(
    `SELECT ${DRIFT_COLUMNS}
       FROM data_contract_drift_events
      WHERE workspace_id = $1
        AND data_contract_id = $2
        AND resolved_at IS NULL
      ORDER BY observed_at DESC
      LIMIT 200`,
    [workspaceId, dataContractId],
  );
  return result.rows;
}

export interface DriftRowForSource extends DataContractDriftRow {
  data_contract_name: string;
}

/**
 * List unresolved drift events for every Data Contract attached to a
 * single source. Used by the drift panel on the source detail page —
 * one source can have multiple maps (e.g. a draft + an active), and the
 * panel shows drift across all of them.
 */
export async function listUnresolvedDriftForSource(
  workspaceId: string,
  sourceId: string,
  client: Queryable = db(),
): Promise<DriftRowForSource[]> {
  const result = await client.query<DriftRowForSource>(
    `SELECT de.id::text          AS id,
            de.data_contract_id,
            de.data_contract_version_id,
            de.workspace_id,
            de.category,
            de.field_path,
            de.detail,
            de.sample_event_id,
            de.observed_at::text  AS observed_at,
            de.resolved_at::text  AS resolved_at,
            de.resolved_by_user_id,
            em.name               AS data_contract_name
       FROM data_contract_drift_events de
       JOIN data_contracts em
         ON em.id = de.data_contract_id
        AND em.workspace_id = de.workspace_id
      WHERE de.workspace_id = $1
        AND em.source_id = $2
        AND de.resolved_at IS NULL
      ORDER BY de.observed_at DESC
      LIMIT 100`,
    [workspaceId, sourceId],
  );
  return result.rows;
}

export async function resolveDriftEvent(
  id: string,
  workspaceId: string,
  resolvedByUserId: string,
  client: Queryable = db(),
): Promise<void> {
  await client.query(
    `UPDATE data_contract_drift_events
        SET resolved_at = now(), resolved_by_user_id = $3
      WHERE id::text = $1 AND workspace_id = $2 AND resolved_at IS NULL`,
    [id, workspaceId, resolvedByUserId],
  );
}
