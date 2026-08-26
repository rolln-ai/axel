"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { db, withTransaction } from "../db";
import { requireSession } from "../session";
import { requireActiveWorkspace, requireWritableRole } from "../auth-guards";
import {
  buildFixturesFromSamples,
  canActivate,
  generateRouteArtifacts,
  runFixtures,
  type FixtureRunResult,
  type GeneratedFilter,
  type GeneratedTransform,
  type SyntheticFixture,
} from "./codegen";
import type {
  DestinationMapping,
} from "./destination-mapping";
import type { RouteDestinationBinding } from "@axel/shared";
import type { InferredDataContract } from "./inference";
import {
  appendDataContractVersion,
  getDataContract,
  getDataContractVersion,
  insertDataContractFixture,
} from "./repository";
import { sampleSourceEvents } from "./sampler";
import { writeAudit } from "../audit";

/**
 * Server actions wrapping AXE-45 codegen + activation gate.
 *
 * Flow on the Data Contract detail page:
 *   1. propose: read version → call generateRouteArtifacts → return filter
 *      + transform + freshly-built fixtures.
 *   2. attach: run fixture gate against the proposed transform; if it
 *      passes, persist into a new version with generated_filter +
 *      generated_transform + fixtures, then create a route with
 *      engine='declarative' (edge router will execute these inline
 *      without sandbox eval).
 *
 * Owner/admin only. Single transaction for attach so either everything
 * commits or nothing does.
 */

export interface ProposedArtifacts {
  filter: GeneratedFilter;
  transform: GeneratedTransform;
  fixtures: SyntheticFixture[];
  fixture_result: FixtureRunResult;
  can_activate: boolean;
}

export interface ProposeArtifactsState {
  error?: string;
  artifacts?: ProposedArtifacts;
}

export async function proposeRouteArtifactsAction(
  dataContractId: string,
): Promise<ProposeArtifactsState> {
  const session = await requireSession();
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const workspaceId = session.activeWorkspace.workspace_id;

  const map = await getDataContract(dataContractId, workspaceId);
  if (!map) return { error: "Data Contract not found." };
  if (!map.current_version_id) {
    return { error: "Data Contract has no version yet." };
  }
  const version = await getDataContractVersion(map.current_version_id, workspaceId);
  if (!version) return { error: "Current Data Contract version not found." };

  const inferred = version.inferred_schema as InferredDataContract;
  const mapping = version.destination_mapping as DestinationMapping | null;
  if (!mapping) {
    return {
      error:
        "Save a destination mapping first — the codegen needs a destination shape to generate filter + transform from.",
    };
  }

  let samples: Awaited<ReturnType<typeof sampleSourceEvents>>;
  try {
    samples = await sampleSourceEvents(workspaceId, map.source_id, {
      maxEvents: 30,
    });
  } catch (err) {
    return {
      error: `Couldn't sample events for fixture generation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (samples.length === 0) {
    return {
      error: "No recent events to use for fixtures. Send some events to the source and retry.",
    };
  }

  const { filter, transform } = generateRouteArtifacts(inferred, mapping);
  const fixtures = buildFixturesFromSamples(samples, inferred, transform);
  const fixture_result = runFixtures(fixtures, transform);

  return {
    artifacts: {
      filter,
      transform,
      fixtures,
      fixture_result,
      can_activate: canActivate(fixture_result),
    },
  };
}

export interface AttachRouteState {
  error?: string;
  notice?: string;
  version_id?: string;
  route_id?: string;
  fixture_result?: FixtureRunResult;
}

export async function attachToRouteAction(
  dataContractId: string,
): Promise<AttachRouteState> {
  const session = await requireSession();
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const userId = session.user.id;

  const map = await getDataContract(dataContractId, workspaceId);
  if (!map) return { error: "Data Contract not found." };
  if (!map.current_version_id) {
    return { error: "Data Contract has no version yet." };
  }
  const version = await getDataContractVersion(map.current_version_id, workspaceId);
  if (!version) return { error: "Current Data Contract version not found." };

  const inferred = version.inferred_schema as InferredDataContract;
  const mapping = version.destination_mapping as DestinationMapping | null;
  if (!mapping) {
    return {
      error:
        "Save a destination mapping first. Codegen needs a destination shape to generate the route transform.",
    };
  }

  let samples: Awaited<ReturnType<typeof sampleSourceEvents>>;
  try {
    samples = await sampleSourceEvents(workspaceId, map.source_id, {
      maxEvents: 30,
    });
  } catch (err) {
    return {
      error: `Couldn't sample events for fixture generation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (samples.length === 0) {
    return {
      error: "No recent events for fixtures. Send some events and retry.",
    };
  }

  const { filter, transform } = generateRouteArtifacts(inferred, mapping);
  const fixtures = buildFixturesFromSamples(samples, inferred, transform);
  const fixture_result = runFixtures(fixtures, transform);

  if (!canActivate(fixture_result)) {
    return {
      error: `Activation gate refused: ${fixture_result.failed}/${fixture_result.total} fixtures failed.`,
      fixture_result,
    };
  }

  // Persist the new version + fixtures + create the route in one
  // transaction. If any step throws (FK violation, schema mismatch,
  // permission), nothing commits.
  try {
    const result = await withTransaction(async (client) => {
      const newVersion = await appendDataContractVersion(
        {
          dataContractId,
          workspaceId,
          inferredSchema: inferred,
          fieldAnnotations: version.field_annotations,
          generatedFilter: JSON.stringify(filter),
          generatedTransform: JSON.stringify(transform),
          transformLanguage: "jsonata",
          destinationMapping: mapping,
          modelMetadata: {
            ...(version.model_metadata as Record<string, unknown>),
            codegen_at: new Date().toISOString(),
            codegen_by_user_id: userId,
          },
          fixtureResults: {
            passed: fixture_result.passed,
            failed: fixture_result.failed,
            total: fixture_result.total,
            ran_at: fixture_result.ran_at,
          },
          createdByUserId: userId,
        },
        client,
      );

      for (const fixture of fixtures) {
        await insertDataContractFixture(
          {
            dataContractVersionId: newVersion.id,
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
      // Auto-named ("<source> pipeline", capped at 64) — this codegen path has no
      // UI to prompt for a name; the operator can rename it on the route page.
      await client.query(
        `INSERT INTO routes
           (id, workspace_id, source_id, name, status, engine,
            filter_expression, transform_script)
         VALUES ($1, $2, $3,
                 left((SELECT name FROM sources WHERE id = $3 AND workspace_id = $2) || ' pipeline', 64),
                 'active', 'declarative', $4, $5)`,
        [
          routeId,
          workspaceId,
          map.source_id,
          JSON.stringify(filter),
          JSON.stringify(transform),
        ],
      );
      await client.query(
        `INSERT INTO route_destinations (route_id, destination_id, binding)
         VALUES ($1, $2, $3)`,
        [
          routeId,
          mapping.destination_id,
          JSON.stringify(bindingForMapping(mapping)),
        ],
      );
      await writeAudit(client, {
        workspaceId,
        actorUserId: userId,
        action: "route.created",
        targetType: "route",
        targetId: routeId,
        metadata: {
          source_id: map.source_id,
          destination_id: mapping.destination_id,
          data_contract_id: dataContractId,
          data_contract_version_id: newVersion.id,
          engine: "declarative",
          via: "data_contract_attach",
        },
      });

      return { route_id: routeId, version_id: newVersion.id };
    });

    // Cache busting so the routes index + edge route cache pick up the
    // new active route.
    try {
      const tag = `ws-${workspaceId}-routes`;
      // updateTag is a Next 16 thing; revalidatePath covers older.
      revalidatePath("/routes");
      revalidatePath(`/data-contracts/${dataContractId}`);
      void tag;
    } catch {
      /* best-effort */
    }
    void db; // ensure imported

    return {
      notice: `Route ${result.route_id} created with declarative engine. Fixtures: ${fixture_result.passed}/${fixture_result.total} passing.`,
      route_id: result.route_id,
      version_id: result.version_id,
      fixture_result,
    };
  } catch (err) {
    return {
      error: `Couldn't attach route: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function bindingForMapping(
  mapping: DestinationMapping,
): RouteDestinationBinding | null {
  if (mapping.kind === "postgres") {
    return mapping.mode === "columns"
      ? { table: mapping.table, mode: "dotted_columns" }
      : {
          table: mapping.table,
          mode: "jsonb_blob",
          payload_column: mapping.jsonb_column ?? "payload",
        };
  }
  if (mapping.kind === "mongodb") {
    return {
      collection: mapping.collection,
      ...(mapping.id_path ? { idempotency_field: "_id" } : {}),
    };
  }
  if (mapping.kind === "bigquery") {
    return {
      dataset: mapping.dataset,
      table: mapping.table,
      mode: mapping.mode,
    };
  }
  return null;
}
