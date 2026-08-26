"use server";

import { revalidatePath } from "next/cache";
import { db } from "../db";
import { requireSession, type CurrentSession } from "../session";
import { requireActiveWorkspace, requireWritableRole } from "../auth-guards";
import { sampleSourceEvents, type SampledEvent } from "./sampler";
import {
  proposeBigQueryMapping,
  proposeMongoMapping,
  proposePostgresMapping,
  proposeWebhookMapping,
  type BigQueryIntrospection,
  type DestinationMapping,
  type MongoIntrospection,
  type PostgresIntrospection,
  type WebhookIntrospection,
} from "./destination-mapping";
import {
  introspectMongoDestination,
  introspectPostgresDestination,
} from "./destination-introspect";
import { introspectBigQueryDestination } from "../destination-inspect";
import {
  appendDataContractVersion,
  getDataContract,
  getDataContractVersion,
} from "./repository";
import type { InferredDataContract } from "./inference";

/**
 * Server actions wrapping AXE-44 destination mapping proposals and
 * the AXE-43 saveAnnotations flow's destination_mapping slot.
 *
 * The proposal is computed from a fresh introspection of the chosen
 * destination plus a fresh sample of recent events for the source.
 * Saving appends a new immutable Data Contract version with the mapping
 * baked into version.destination_mapping — same persistence path the
 * codegen flow (AXE-45) reads from when generating route artifacts.
 */
interface PickerSession {
  user: { id: string };
  activeWorkspace: { workspace_id: string; role: CurrentSession["activeWorkspace"]["role"] };
}

export interface DestinationPickerOption {
  id: string;
  name: string | null;
  type: string;
}

export interface ProposeMappingState {
  error?: string;
  notice?: string;
  proposal?: DestinationMapping;
  /** Preview rows = proposal.preview shape, but typed here for clarity. */
  preview?: Array<{ event_id: string; before: unknown; after: unknown }>;
  destination_id?: string;
  destination_type?: string;
}

export interface ProposeMappingDeps {
  sampler?: typeof sampleSourceEvents;
  /** Fetch the destination row (workspace-scoped). */
  destinationFetcher?: (
    workspaceId: string,
    destinationId: string,
  ) => Promise<{ id: string; type: string; config: Record<string, unknown>; name: string | null } | null>;
  /** Postgres introspection. Wired to the production driver in default. */
  postgresIntrospect?: (
    workspaceId: string,
    destinationId: string,
    target?: string,
  ) => Promise<PostgresIntrospection | null>;
  /** Mongo introspection. */
  mongoIntrospect?: (
    workspaceId: string,
    destinationId: string,
    target?: string,
  ) => Promise<MongoIntrospection | null>;
  bigqueryIntrospect?: (
    destinationId: string,
    workspaceId: string,
    options: { dataset?: string; table: string },
  ) => Promise<BigQueryIntrospection>;
}

const WEBHOOK_INTROSPECTION: WebhookIntrospection = {
  signature_header: "x-axel-signature",
};

export async function proposeDestinationMappingImpl(
  session: PickerSession,
  input: { dataContractId: string; destinationId: string; target?: string },
  deps: ProposeMappingDeps = {},
): Promise<ProposeMappingState> {
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const fetcher = deps.destinationFetcher ?? defaultDestinationFetcher;

  const map = await getDataContract(input.dataContractId, workspaceId);
  if (!map) return { error: "Data Contract not found." };
  if (!map.current_version_id) {
    return { error: "Data Contract has no version yet — run Understand source first." };
  }
  const version = await getDataContractVersion(map.current_version_id, workspaceId);
  if (!version) return { error: "Current Data Contract version not found." };

  const destination = await fetcher(workspaceId, input.destinationId);
  if (!destination) return { error: "Destination not found in this workspace." };

  const sampler = deps.sampler ?? sampleSourceEvents;
  let samples: SampledEvent[];
  try {
    samples = await sampler(workspaceId, map.source_id, { maxEvents: 30 });
  } catch (err) {
    return {
      error: `Couldn't sample events for preview: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (samples.length === 0) {
    return {
      error: "No recent events to use for preview. Send some events to the source and retry.",
    };
  }

  const inferred = version.inferred_schema as InferredDataContract;

  const target = (input.target ?? "").trim();

  try {
    let proposal: DestinationMapping;
    if (destination.type === "postgres") {
      if (!target) {
        return { error: "Choose a target table for this Postgres destination." };
      }
      const intro = await (deps.postgresIntrospect ?? introspectPostgresDestination)(
        workspaceId,
        destination.id,
        target,
      );
      if (!intro) {
        return {
          error: `Table "${target}" wasn't found in the destination — create it first, or pick an existing table.`,
        };
      }
      proposal = proposePostgresMapping(destination.id, intro, inferred, samples);
    } else if (destination.type === "mongodb") {
      if (!target) {
        return { error: "Choose a target collection for this MongoDB destination." };
      }
      const intro = await (deps.mongoIntrospect ?? introspectMongoDestination)(
        workspaceId,
        destination.id,
        target,
      );
      if (!intro) {
        return {
          error: `Couldn't read collection "${target}" — check the destination is reachable and the collection exists.`,
        };
      }
      proposal = proposeMongoMapping(destination.id, intro, inferred, samples);
    } else if (destination.type === "bigquery") {
      const parsed = parseBigQueryTarget(target);
      if (!parsed) {
        return { error: "Choose a BigQuery target as dataset.table." };
      }
      const intro = await (deps.bigqueryIntrospect ?? introspectBigQueryDestination)(
        destination.id,
        workspaceId,
        parsed,
      );
      proposal = proposeBigQueryMapping(destination.id, intro, samples);
    } else if (
      destination.type === "webhook" ||
      destination.type === "http"
    ) {
      proposal = proposeWebhookMapping(
        destination.id,
        WEBHOOK_INTROSPECTION,
        inferred,
        samples,
      );
    } else {
      return {
        error: `Mapping proposals don't support destination type "${destination.type}" yet.`,
      };
    }
    return {
      proposal,
      preview: proposal.preview,
      destination_id: destination.id,
      destination_type: destination.type,
    };
  } catch (err) {
    return {
      error: `Mapping failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseBigQueryTarget(
  target: string,
): { dataset: string; table: string } | null {
  const dot = target.indexOf(".");
  if (dot <= 0 || dot === target.length - 1) return null;
  const dataset = target.slice(0, dot).trim();
  const table = target.slice(dot + 1).trim();
  return dataset && table ? { dataset, table } : null;
}

export interface SaveMappingDeps {
  versionAppender?: typeof appendDataContractVersion;
}

export async function saveDestinationMappingImpl(
  session: PickerSession,
  input: { dataContractId: string; mapping: DestinationMapping },
  deps: SaveMappingDeps = {},
): Promise<{ error?: string; notice?: string; version_id?: string }> {
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const map = await getDataContract(input.dataContractId, workspaceId);
  if (!map) return { error: "Data Contract not found." };
  if (!map.current_version_id) {
    return { error: "Data Contract has no version yet." };
  }
  const current = await getDataContractVersion(map.current_version_id, workspaceId);
  if (!current) return { error: "Current Data Contract version not found." };

  const versionAppender = deps.versionAppender ?? appendDataContractVersion;
  const version = await versionAppender({
    dataContractId: input.dataContractId,
    workspaceId,
    inferredSchema: current.inferred_schema,
    fieldAnnotations: current.field_annotations,
    generatedFilter: current.generated_filter,
    generatedTransform: current.generated_transform,
    transformLanguage: current.transform_language,
    destinationMapping: input.mapping,
    modelMetadata: {
      ...(current.model_metadata as Record<string, unknown>),
      destination_mapping_saved_at: new Date().toISOString(),
      destination_mapping_saved_by_user_id: session.user.id,
    },
    createdByUserId: session.user.id,
  });

  return {
    notice: "Destination mapping saved on a new version.",
    version_id: version.id,
  };
}

export async function proposeDestinationMappingAction(input: {
  dataContractId: string;
  destinationId: string;
  /** Target table (postgres) / collection (mongodb). Required for those types. */
  target?: string;
}): Promise<ProposeMappingState> {
  const session = await requireSession();
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  return proposeDestinationMappingImpl(session, input);
}

export async function saveDestinationMappingAction(input: {
  dataContractId: string;
  mapping: DestinationMapping;
}): Promise<{ error?: string; notice?: string; version_id?: string }> {
  const session = await requireSession();
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const result = await saveDestinationMappingImpl(session, input);
  if (!result.error) {
    revalidatePath(`/data-contracts/${input.dataContractId}`);
  }
  return result;
}

export interface ListDestinationsDeps {
  client?: typeof db extends () => infer R ? R : never;
}

/**
 * Server action that returns the list of destinations the operator
 * can pick from. Used by the picker dropdown.
 */
export async function listDestinationsForPickerAction(): Promise<
  DestinationPickerOption[]
> {
  const session = await requireSession();
  const result = await db().query<DestinationPickerOption>(
    `SELECT id, name, type
       FROM destinations
      WHERE workspace_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 200`,
    [session.activeWorkspace.workspace_id],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Default introspection implementations.
// ---------------------------------------------------------------------------

async function defaultDestinationFetcher(
  workspaceId: string,
  destinationId: string,
): Promise<{ id: string; type: string; config: Record<string, unknown>; name: string | null } | null> {
  const result = await db().query<{
    id: string;
    type: string;
    config: Record<string, unknown>;
    name: string | null;
  }>(
    `SELECT id, type, config, name
       FROM destinations
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [destinationId, workspaceId],
  );
  return result.rows[0] ?? null;
}

// Real introspection lives in destination-introspect.ts so this
// actions file stays focused on session-scoped orchestration.
