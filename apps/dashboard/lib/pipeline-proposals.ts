"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import {
  RouteEngineError,
  validatePipelineGraph,
  type GeneratedFilter,
  type GeneratedTransform,
  type PipelineGraph,
  type RouteDestinationBinding,
} from "@axel/shared";
import { db, withTransaction } from "./db";
import { requireSession, type CurrentSession } from "./session";
import { requireActiveWorkspace, requireWritableRole } from "./auth-guards";
import { cacheTags } from "./repositories";
import { updateTag } from "next/cache";
import { createBackfillJob } from "./backfill-jobs";
import {
  appendDataContractVersion,
  createDataContract,
  getDataContractVersion,
  insertDataContractFixture,
  listDataContractsForSource,
  type DataContractRow,
  type DataContractVersionRow,
} from "./data-contracts/repository";
import {
  buildFixturesFromSamples,
  canActivate,
  generateRouteArtifacts,
  runFixtures,
  withTransientStatusFields,
  type FixtureRunResult,
  type SyntheticFixture,
} from "./data-contracts/codegen";
import {
  proposeBigQueryMapping,
  proposeMongoMapping,
  proposePostgresMapping,
  proposeWebhookMapping,
  type BigQueryMapping,
  type DestinationMapping,
  type MongoMapping,
  type PostgresMapping,
  type WebhookMapping,
} from "./data-contracts/destination-mapping";
import {
  introspectMongoDestination,
  introspectPostgresDestination,
} from "./data-contracts/destination-introspect";
import { introspectBigQueryDestination } from "./destination-inspect";
import { normalizeBigQueryTarget } from "./pipeline-binding";
import { inferDataContract, type InferredDataContract } from "./data-contracts/inference";
import { sampleSourceEvents, type SampledEvent } from "./data-contracts/sampler";
import type { DestinationType } from "./destination-defaults";
import { entityNameError } from "./entity-name";
import { writeAudit } from "./audit";

export interface PipelineGoalInput {
  /** Human-readable pipeline name. Required at apply (route creation) time. */
  name?: string;
  goal: string;
  sourceId: string;
  destinationId: string;
  /**
   * Target table (Postgres), collection (MongoDB), or dataset.table (BigQuery)
   * to write to. Required for those "container" destination types — they store
   * the target as a per-route binding, not on the destination, so the proposal
   * can't infer it. Ignored for webhook/http destinations (the URL is the target).
   */
  target?: string;
  backfillDays?: number;
}

export interface PipelineProposal {
  input: Required<PipelineGoalInput>;
  source: { id: string; name: string };
  destination: { id: string; name: string | null; type: DestinationType };
  data_contract: {
    id: string | null;
    version_id: string | null;
    status: "existing" | "new_from_samples";
    sample_count: number;
    event_types: Array<{ name: string; sample_count: number; selected: boolean }>;
    field_count: number;
    sensitive_field_count: number;
    summary: string;
  };
  selected_event_type_names: string[];
  mapping: DestinationMapping;
  filter: GeneratedFilter;
  transform: GeneratedTransform;
  graph: PipelineGraph;
  binding: RouteDestinationBinding | null;
  validation: {
    fixture_result: FixtureRunResult;
    can_activate: boolean;
    graph_ok: boolean;
    warnings: string[];
  };
  preview: Array<{ event_id: string; before: unknown; after: unknown }>;
}

export type ProposePipelineGoalResult =
  | { ok: true; proposal: PipelineProposal }
  | { ok: false; error: string };

export type ApplyPipelineGoalResult =
  | { ok: true; route_id: string; data_contract_id: string; version_id: string; notice: string }
  | { ok: false; error: string; proposal?: PipelineProposal };

interface ActionSession {
  user: { id: string };
  activeWorkspace: {
    workspace_id: string;
    role: CurrentSession["activeWorkspace"]["role"];
  };
}

interface DestinationRow {
  id: string;
  name: string | null;
  type: DestinationType;
  config: Record<string, unknown>;
}

interface BuiltPipelineProposal {
  proposal: PipelineProposal;
  inferred: InferredDataContract;
  fixtures: SyntheticFixture[];
}

function normalizeInput(input: PipelineGoalInput): Required<PipelineGoalInput> {
  const backfillRaw = Number.isFinite(input.backfillDays)
    ? Math.floor(input.backfillDays ?? 0)
    : 0;
  return {
    name: (input.name ?? "").trim(),
    goal: input.goal.trim(),
    sourceId: input.sourceId.trim(),
    destinationId: input.destinationId.trim(),
    target: (input.target ?? "").trim(),
    backfillDays: Math.max(0, Math.min(30, backfillRaw)),
  };
}

async function loadSource(workspaceId: string, sourceId: string) {
  const result = await db().query<{ id: string; name: string }>(
    `SELECT id, name
       FROM sources
      WHERE id = $1 AND workspace_id = $2 AND status = 'active'
      LIMIT 1`,
    [sourceId, workspaceId],
  );
  return result.rows[0] ?? null;
}

async function loadDestination(workspaceId: string, destinationId: string) {
  const result = await db().query<DestinationRow>(
    `SELECT id, name, type, config
       FROM destinations
      WHERE id = $1 AND workspace_id = $2 AND status = 'active'
      LIMIT 1`,
    [destinationId, workspaceId],
  );
  return result.rows[0] ?? null;
}

async function loadBestContract(
  workspaceId: string,
  sourceId: string,
): Promise<{ map: DataContractRow; version: DataContractVersionRow } | null> {
  const maps = await listDataContractsForSource(workspaceId, sourceId);
  const current = maps.find((m) => m.current_version_id) ?? null;
  if (!current?.current_version_id) return null;
  const version = await getDataContractVersion(current.current_version_id, workspaceId);
  if (!version) return null;
  return { map: current, version };
}

function selectEventTypesFromGoal(
  goal: string,
  inferred: InferredDataContract,
): string[] {
  const normalized = goal.toLowerCase();
  const selected = inferred.event_types
    .map((eventType) => eventType.name)
    .filter((name) => normalized.includes(name.toLowerCase()));
  return Array.from(new Set(selected));
}

function summarizeWarnings(input: {
  selectedEventTypes: string[];
  mapping: DestinationMapping;
  fixtureResult: FixtureRunResult;
  inferred: InferredDataContract;
  dataContractStatus: PipelineProposal["data_contract"]["status"];
}): string[] {
  const warnings: string[] = [];
  if (input.selectedEventTypes.length === 0) {
    warnings.push("No event-type filter set — every observed event type is forwarded.");
  }
  if (input.mapping.kind === "postgres" && input.mapping.mode === "jsonb" && !input.mapping.jsonb_column) {
    warnings.push("The target Postgres table did not expose a JSONB column during introspection; create one before delivery.");
  }
  if (input.mapping.kind === "mongodb" && !input.mapping.id_path) {
    warnings.push("No stable Mongo id path was detected, so replays may insert duplicates.");
  }
  if (input.fixtureResult.total === 0) {
    warnings.push("No fixtures were generated from samples.");
  }
  if (input.inferred.sensitive_fields.length > 0) {
    warnings.push(`${input.inferred.sensitive_fields.length} sensitive field(s) were detected; review the mapped output before approving.`);
  }
  if (input.dataContractStatus === "new_from_samples") {
    warnings.push("No existing Data Contract was found; approving will create one from the current samples.");
  }
  return warnings;
}

function buildPipelineGraph(input: {
  filter: GeneratedFilter;
  transform: GeneratedTransform;
  destinationId: string;
}): PipelineGraph {
  const nodes: PipelineGraph["nodes"] = [{ id: "n_src", kind: "source" }];
  const edges: PipelineGraph["edges"] = [];
  let cursor = "n_src";

  if (input.filter.kind !== "always") {
    nodes.push({ id: "n_f_goal", kind: "filter", filter: input.filter });
    edges.push({ from: cursor, to: "n_f_goal" });
    cursor = "n_f_goal";
  }
  if (input.transform.kind !== "passthrough") {
    nodes.push({ id: "n_t_goal", kind: "transform", transform: input.transform });
    edges.push({ from: cursor, to: "n_t_goal" });
    cursor = "n_t_goal";
  }
  nodes.push({
    id: `n_dst_${input.destinationId}`,
    kind: "destination",
    destination_id: input.destinationId,
  });
  edges.push({ from: cursor, to: `n_dst_${input.destinationId}` });

  const graph: PipelineGraph = { version: 1, nodes, edges };
  const col = 260;
  return {
    ...graph,
    ui: Object.fromEntries(
      graph.nodes.map((node, index) => [node.id, { x: index * col, y: 200 }]),
    ),
  };
}

function bindingForMapping(mapping: DestinationMapping): RouteDestinationBinding | null {
  if (mapping.kind === "postgres") {
    const pg = mapping as PostgresMapping;
    if (pg.mode === "columns") {
      return { table: pg.table, mode: "dotted_columns" };
    }
    return {
      table: pg.table,
      mode: "jsonb_blob",
      payload_column: pg.jsonb_column ?? "payload",
    };
  }
  if (mapping.kind === "mongodb") {
    const mongo = mapping as MongoMapping;
    return {
      collection: mongo.collection,
      ...(mongo.id_path ? { idempotency_field: "_id" } : {}),
    };
  }
  if (mapping.kind === "bigquery") {
    const bigquery = mapping as BigQueryMapping;
    return {
      dataset: bigquery.dataset,
      table: bigquery.table,
      mode: "typed_records",
    };
  }
  return null;
}

async function proposeMapping(input: {
  workspaceId: string;
  destination: DestinationRow;
  inferred: InferredDataContract;
  samples: SampledEvent[];
  target: string;
}): Promise<DestinationMapping> {
  if (input.destination.type === "postgres") {
    if (!input.target) {
      throw new Error("Choose a target table for this Postgres destination.");
    }
    let intro: Awaited<ReturnType<typeof introspectPostgresDestination>>;
    try {
      intro = await introspectPostgresDestination(
        input.workspaceId,
        input.destination.id,
        input.target,
      );
    } catch (err) {
      // Postgres introspection surfaces connection/TLS failures (e.g. a
      // self-signed certificate on a Railway proxy) — pass the real cause
      // through instead of masking it.
      throw new Error(
        `Couldn't connect to the Postgres destination to read "${input.target}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!intro) {
      throw new Error(
        `Table "${input.target}" wasn't found in the destination — create it first, or pick an existing table.`,
      );
    }
    return proposePostgresMapping(input.destination.id, intro, input.inferred, input.samples);
  }
  if (input.destination.type === "mongodb") {
    if (!input.target) {
      throw new Error("Choose a target collection for this MongoDB destination.");
    }
    const intro = await introspectMongoDestination(
      input.workspaceId,
      input.destination.id,
      input.target,
    );
    if (!intro) {
      throw new Error(
        `Couldn't read collection "${input.target}" — check the destination is reachable and the collection exists.`,
      );
    }
    return proposeMongoMapping(input.destination.id, intro, input.inferred, input.samples);
  }
  if (input.destination.type === "bigquery") {
    const target = normalizeBigQueryTarget(input.target);
    if (!target) {
      throw new Error("Choose a BigQuery dataset and table in dataset.table format.");
    }
    const intro = await introspectBigQueryDestination(
      input.destination.id,
      input.workspaceId,
      target,
    );
    return proposeBigQueryMapping(input.destination.id, intro, input.samples);
  }
  if (input.destination.type === "webhook" || input.destination.type === "http") {
    return proposeWebhookMapping(
      input.destination.id,
      { signature_header: "x-axel-signature" },
      input.inferred,
      input.samples,
    ) as WebhookMapping;
  }
  throw new Error(`Pipeline creation does not support destination type "${input.destination.type}" yet.`);
}

async function buildPipelineProposal(
  session: ActionSession,
  rawInput: PipelineGoalInput,
): Promise<BuiltPipelineProposal> {
  const input = normalizeInput(rawInput);
  // The filter/transform instruction is optional. An empty goal selects no
  // specific event types, which the pipeline already treats as "forward every
  // observed event type" (see selectEventTypesFromGoal + summarizeWarnings); the
  // mapping/filter/transform are derived from the destination + inferred schema,
  // not the goal text.
  if (!input.sourceId) throw new Error("Pick a source.");
  if (!input.destinationId) throw new Error("Pick a destination.");

  const workspaceId = session.activeWorkspace.workspace_id;
  const source = await loadSource(workspaceId, input.sourceId);
  if (!source) throw new Error("Source not found in this workspace.");
  const destination = await loadDestination(workspaceId, input.destinationId);
  if (!destination) throw new Error("Destination not found in this workspace.");

  const samples = await sampleSourceEvents(workspaceId, source.id, {
    maxEvents: 30,
    maxBytes: 1 * 1024 * 1024,
  });
  if (samples.length === 0) {
    throw new Error("No recent events are available. Send events to the source and try again.");
  }

  const existingContract = await loadBestContract(workspaceId, source.id);
  const inferred = existingContract
    ? (existingContract.version.inferred_schema as InferredDataContract)
    : await inferDataContract(samples);
  const contractStatus: PipelineProposal["data_contract"]["status"] = existingContract
    ? "existing"
    : "new_from_samples";

  const selectedEventTypes = selectEventTypesFromGoal(input.goal, inferred);
  // Durable contracts no longer retain observed status values. Recompute that
  // small value-bearing slice from the fresh in-memory sample so a goal such as
  // "only invoice.paid" still produces an exact filter without storing the
  // values in Postgres.
  const codegenInferred = existingContract
    ? withTransientStatusFields(inferred, samples)
    : inferred;
  const mapping = await proposeMapping({
    workspaceId,
    destination,
    inferred,
    samples,
    target: input.target,
  });
  const { filter, transform } = generateRouteArtifacts(codegenInferred, mapping, {
    selected_event_type_names: selectedEventTypes,
  });
  const fixtures = buildFixturesFromSamples(samples, inferred, transform);
  const fixtureResult = runFixtures(fixtures, transform);
  const graph = buildPipelineGraph({ filter, transform, destinationId: destination.id });

  try {
    validatePipelineGraph(graph, {
      attached_destination_ids: new Set([destination.id]),
    });
  } catch (err) {
    const reason = err instanceof RouteEngineError ? err.reason : "graph_invalid";
    throw new Error(`Generated graph failed validation: ${reason}`);
  }

  const warnings = summarizeWarnings({
    selectedEventTypes,
    mapping,
    fixtureResult,
    inferred,
    dataContractStatus: contractStatus,
  });

  const proposal: PipelineProposal = {
    input,
    source,
    destination: {
      id: destination.id,
      name: destination.name,
      type: destination.type,
    },
    data_contract: {
      id: existingContract?.map.id ?? null,
      version_id: existingContract?.version.id ?? null,
      status: contractStatus,
      sample_count: samples.length,
      event_types: inferred.event_types.map((eventType) => ({
        name: eventType.name,
        sample_count: eventType.sample_count,
        selected: selectedEventTypes.includes(eventType.name),
      })),
      field_count: Object.keys(inferred.fields).length,
      sensitive_field_count: inferred.sensitive_fields.length,
      summary: inferred.summary,
    },
    selected_event_type_names: selectedEventTypes,
    mapping,
    filter,
    transform,
    graph,
    binding: bindingForMapping(mapping),
    validation: {
      fixture_result: fixtureResult,
      can_activate: canActivate(fixtureResult),
      graph_ok: true,
      warnings,
    },
    preview: mapping.preview.slice(0, 3),
  };
  return { proposal, inferred, fixtures };
}

export async function proposePipelineGoalAction(
  input: PipelineGoalInput,
): Promise<ProposePipelineGoalResult> {
  const session = await requireSession();
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { ok: false, error: roleError };
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { ok: false, error: wsError };
  try {
    const built = await buildPipelineProposal(session, input);
    return { ok: true, proposal: built.proposal };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not prepare the pipeline preview.",
    };
  }
}

export async function applyPipelineGoalAction(
  input: PipelineGoalInput,
): Promise<ApplyPipelineGoalResult> {
  const session = await requireSession();
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { ok: false, error: roleError };
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { ok: false, error: wsError };

  let built: BuiltPipelineProposal;
  try {
    built = await buildPipelineProposal(session, input);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not prepare the pipeline.",
    };
  }
  const { proposal } = built;

  if (!proposal.validation.can_activate) {
    return {
      ok: false,
      error: `Activation gate refused: ${proposal.validation.fixture_result.failed}/${proposal.validation.fixture_result.total} fixtures failed.`,
      proposal,
    };
  }

  // Pipeline name is required to create the route.
  if (!input.name) return { ok: false, error: "Name your pipeline.", proposal };
  const nameErr = entityNameError(input.name);
  if (nameErr) return { ok: false, error: nameErr, proposal };

  const workspaceId = session.activeWorkspace.workspace_id;
  const userId = session.user.id;

  try {
    const result = await withTransaction(async (client) => {
      let dataContractId = proposal.data_contract.id;
      if (!dataContractId) {
        const map = await createDataContract(
          {
            workspaceId,
            sourceId: proposal.source.id,
            name: `${proposal.source.name} pipeline`,
            createdByUserId: userId,
          },
          client,
        );
        dataContractId = map.id;
      }

      const version = await appendDataContractVersion(
        {
          dataContractId,
          workspaceId,
          inferredSchema: built.inferred,
          generatedFilter: JSON.stringify(proposal.filter),
          generatedTransform: JSON.stringify(proposal.transform),
          transformLanguage: "jsonata",
          destinationMapping: proposal.mapping,
          modelMetadata: {
            pipeline_goal: proposal.input.goal,
            pipeline_goal_applied_at: new Date().toISOString(),
            pipeline_goal_applied_by_user_id: userId,
            selected_event_type_names: proposal.selected_event_type_names,
          },
          fixtureResults: {
            passed: proposal.validation.fixture_result.passed,
            failed: proposal.validation.fixture_result.failed,
            total: proposal.validation.fixture_result.total,
            ran_at: proposal.validation.fixture_result.ran_at,
          },
          createdByUserId: userId,
        },
        client,
      );

      for (const fixture of built.fixtures) {
        await insertDataContractFixture(
          {
            dataContractVersionId: version.id,
            workspaceId,
            sourceEventId: fixture.source_event_id,
            eventType: fixture.event_type,
            inputPayload: fixture.input_payload,
            expectedOutput: fixture.expected_output,
          },
          client,
        );
      }

      const routeId = `rt_${randomBytes(16).toString("base64url")}`;
      await client.query(
        `INSERT INTO routes (id, workspace_id, source_id, name, status, engine, pipeline_graph)
         VALUES ($1, $2, $3, $4, 'active', 'declarative', $5::jsonb)`,
        [routeId, workspaceId, proposal.source.id, input.name, JSON.stringify(proposal.graph)],
      );
      await client.query(
        `INSERT INTO route_destinations (route_id, destination_id, binding)
         VALUES ($1, $2, $3::jsonb)`,
        [
          routeId,
          proposal.destination.id,
          proposal.binding ? JSON.stringify(proposal.binding) : null,
        ],
      );
      await client.query(
        `UPDATE data_contracts
            SET route_id = $3, status = 'active', updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [dataContractId, workspaceId, routeId],
      );
      await writeAudit(client, {
        workspaceId,
        actorUserId: userId,
        action: "route.created",
        targetType: "route",
        targetId: routeId,
        metadata: {
          via: "pipeline_goal",
          goal: proposal.input.goal,
          source_id: proposal.source.id,
          destination_id: proposal.destination.id,
          data_contract_id: dataContractId,
          data_contract_version_id: version.id,
          fixture_result: proposal.validation.fixture_result,
        },
      });

      return { routeId, dataContractId, versionId: version.id };
    });

    let backfillNote = "";
    if (proposal.input.backfillDays > 0) {
      const until = new Date();
      const since = new Date(until.getTime() - proposal.input.backfillDays * 86_400_000);
      try {
        const job = await createBackfillJob({
          workspaceId,
          routeId: result.routeId,
          sourceId: proposal.source.id,
          since,
          until,
          requestedByUserId: userId,
        });
        backfillNote =
          job.total_estimated > 0
            ? ` Backfill queued (${job.total_estimated.toLocaleString()} event${job.total_estimated === 1 ? "" : "s"} estimated).`
            : " Backfill queued.";
      } catch (err) {
        backfillNote = ` Route created, but backfill could not be queued: ${
          err instanceof Error ? err.message : "unknown error"
        }.`;
      }
    }

    updateTag(cacheTags.routes(workspaceId));
    revalidatePath("/routes");
    revalidatePath(`/routes/${result.routeId}`);
    revalidatePath("/data-contracts");

    return {
      ok: true,
      route_id: result.routeId,
      data_contract_id: result.dataContractId,
      version_id: result.versionId,
      notice: `Created pipeline "${input.name}".${backfillNote}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not create the pipeline.",
      proposal,
    };
  }
}
