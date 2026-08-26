"use server";

import {
  bigQueryRowForEvent,
  compareBigQuerySchemas,
  executeGraph,
  expectedBigQuerySchema,
  normalizeBqType,
  parseFilter,
  parsePipelineGraph,
  parseTransform,
  runFilter,
  runTransform,
  type BigQueryWriteMode,
  type PipelineGraph,
} from "@axel/shared";
import { updateTag } from "next/cache";
import { withWorkspaceMutation } from "./with-mutation";
import { enqueueReplays } from "./replay-enqueue";
import { db, withTransaction, type Queryable } from "./db";
import { introspectBigQueryDestination } from "./destination-inspect";
import { bigQueryModeForBinding } from "./pipeline-binding";
import { prefixedId } from "./ids";
import { fingerprintFor, resolveFingerprintIds, type DeadLetterIdsForFingerprint } from "./inbox";
import {
  addRepairToPipeline,
  parseInboxRepairSpec,
  repairProposalFromIssue,
  repairProposalsFromMessage,
  selectRepairProposalForDeliveryError,
  synthesizeLegacyPipeline,
  type InboxRepairProposal,
  type InboxRepairSpec,
} from "./inbox-repair";
import { dataTypeRepairFor } from "./dead-letter-repair";
import {
  findBigQueryField,
  planBigQueryFieldTypeChange,
  widenBigQueryDestinationField,
} from "./bigquery-schema-change";
import { cacheTags } from "./repositories";
import { fetchPayloadForR2Key } from "./sample-payload";
import type { ActionState } from "./action-state";
import { formValue } from "./form";
import { humanRepairError } from "./inbox-repair-error";

/**
 * Server actions for the AXE-57 inbox-zero workflow.
 *
 * Two bulk actions: `muteFingerprint` writes a row to
 * `dead_letter_mutes` so the entire fingerprint stops appearing in
 * the inbox until `until` (default 24h). `retryFingerprint` enqueues
 * a replay row per distinct (event_id, route_id) — we batch in one
 * INSERT to keep the action snappy when a fingerprint covers
 * thousands of events.
 *
 * Both actions are workspace-scoped via withWorkspaceMutation + the
 * fingerprint resolver re-queries by workspace_id, so a malformed
 * action call can't reach into another workspace's data.
 */

export type { ActionState } from "./action-state";

export type RepairPreviewResult =
  | {
      ok: true;
      proposal: InboxRepairProposal;
      routeId: string;
      destinationId: string;
      schemaRepair?: BigQuerySchemaRepairPreview;
    }
  | { ok: false; error: string };

export interface BigQuerySchemaRepairPreview {
  kind: "bigquery_widen";
  dataset: string;
  table: string;
  fieldPath: string;
  fromType: "INT64";
  toType: "FLOAT64";
  status: "needed" | "already_applied";
}

export interface ApplyInboxRepairInput {
  fingerprint: string;
  exemplarId: string;
  repair: InboxRepairSpec;
}

export interface ApplyInboxSchemaRepairInput {
  fingerprint: string;
  exemplarId: string;
}

export type ApplyInboxRepairResult =
  | { ok: true; notice: string; queued: number }
  | { ok: false; error: string };

const DEFAULT_MUTE_HOURS = 24;
const MAX_MUTE_HOURS = 24 * 30; // 30 days

export async function muteFingerprint(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, actorUserId, audit }) => {
    const fingerprint = formValue(formData, "fingerprint");
    if (!fingerprint) return { error: "fingerprint is required." };

    const hoursRaw = formValue(formData, "hours");
    const hours = hoursRaw ? Math.max(1, Math.min(MAX_MUTE_HOURS, Number(hoursRaw))) : DEFAULT_MUTE_HOURS;
    const reason = formValue(formData, "reason") || null;

    // Active-mute uniqueness is enforced here (PG won't accept a
    // partial unique index whose predicate uses now(), see migration
    // 0013). SELECT existing active mute → UPDATE if found, else
    // INSERT. The race window between SELECT and INSERT is fine in
    // practice — a duplicate active mute is harmless (operator pressed
    // the button twice) and the lookup index keeps the SELECT cheap.
    const existing = await db().query<{ id: string }>(
      `SELECT id FROM dead_letter_mutes
        WHERE workspace_id = $1 AND fingerprint = $2 AND (until IS NULL OR until > now())
        LIMIT 1`,
      [workspaceId, fingerprint],
    );
    if (existing.rowCount && existing.rows[0]) {
      await db().query(
        `UPDATE dead_letter_mutes
            SET until = now() + ($1 || ' hours')::interval,
                reason = COALESCE($2, reason)
          WHERE id = $3`,
        [String(hours), reason, existing.rows[0].id],
      );
    } else {
      await db().query(
        `INSERT INTO dead_letter_mutes (id, workspace_id, fingerprint, reason, until, muted_by_user_id)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, $6)`,
        [prefixedId("dlm"), workspaceId, fingerprint, reason, String(hours), actorUserId],
      );
    }
    await audit({
      action: "dead_letter.muted",
      targetType: "dead_letter_fingerprint",
      targetId: fingerprint,
      metadata: { hours, reason },
    });
    return { notice: `Muted for ${hours}h. Re-mute or visit Inbox → Show muted to bring it back.` };
  });
}

export async function unmuteFingerprint(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit }) => {
    const fingerprint = formValue(formData, "fingerprint");
    if (!fingerprint) return { error: "fingerprint is required." };
    const result = await db().query(
      `UPDATE dead_letter_mutes
          SET until = now()
        WHERE workspace_id = $1 AND fingerprint = $2 AND (until IS NULL OR until > now())`,
      [workspaceId, fingerprint],
    );
    if (!result.rowCount) return { error: "No active mute for that fingerprint." };
    await audit({
      action: "dead_letter.unmuted",
      targetType: "dead_letter_fingerprint",
      targetId: fingerprint,
      metadata: {},
    });
    return { notice: "Mute lifted. The fingerprint is back in the inbox." };
  });
}

/**
 * Resolve the exact field and safe conversion for a permanent BigQuery data
 * mismatch. New dead letters already contain schemaMismatches; older rows fall
 * back to the failed event + live table schema so the operator never has to
 * guess a field name.
 */
export async function previewFingerprintRepair(input: {
  fingerprint: string;
  exemplarId: string;
}): Promise<RepairPreviewResult> {
  return withWorkspaceMutation<RepairPreviewResult>(
    { gateError: (error) => ({ ok: false, error }) },
    async ({ workspaceId }) => {
      try {
        const exemplar = await loadRepairExemplar(workspaceId, input.exemplarId, input.fingerprint);
        if (!exemplar) return { ok: false, error: "This error is no longer active. Refresh the Inbox." };
        if (!exemplar.route_id || !exemplar.destination_id) {
          return { ok: false, error: "Axel could not identify the route and destination for this error." };
        }

        const enriched = selectRepairProposalForDeliveryError(
          exemplar.message,
          repairProposalsFromMessage(exemplar.message),
        );
        const proposal = enriched ?? await diagnoseLegacyRepair(exemplar, workspaceId);
        if (!proposal) {
          return {
            ok: false,
            error: "Axel could not identify one safe automatic conversion for this error. Use Investigate for the full payload.",
          };
        }
        const schemaRepair = await previewBigQuerySchemaRepair(
          workspaceId,
          exemplar.route_id,
          exemplar.destination_id,
          proposal,
        ).catch((err) => {
          // Destination-side widening is an optional, safer alternative to
          // the existing route transform. A metadata permission failure must
          // not remove the transform escape hatch from the operator.
          console.warn(
            "[previewFingerprintRepair] BigQuery schema option unavailable:",
            err instanceof Error ? err.message : err,
          );
          return null;
        });
        return {
          ok: true,
          proposal,
          routeId: exemplar.route_id,
          destinationId: exemplar.destination_id,
          ...(schemaRepair ? { schemaRepair } : {}),
        };
      } catch (err) {
        console.error("[previewFingerprintRepair] failed:", err);
        return {
          ok: false,
          error: err instanceof Error ? humanRepairError(err.message) : "Could not prepare this fix.",
        };
      }
    },
  );
}

/** Atomically update the destination-scoped pipeline and enqueue the replays. */
export async function applyFingerprintRepair(
  input: ApplyInboxRepairInput,
): Promise<ApplyInboxRepairResult> {
  return withWorkspaceMutation<ApplyInboxRepairResult>(
    { billing: "replay", gateError: (error) => ({ ok: false, error }) },
    async ({ workspaceId, actorUserId, audit }) => {
      const repair = parseInboxRepairSpec(input.repair);
      if (!repair) return { ok: false, error: "That repair choice is invalid. Reopen Fix data and try again." };

      const exemplar = await loadRepairExemplar(workspaceId, input.exemplarId, input.fingerprint);
      if (!exemplar) return { ok: false, error: "This error is no longer active. Refresh the Inbox." };
      if (!exemplar.route_id || !exemplar.destination_id) {
        return { ok: false, error: "Axel could not identify the route and destination for this error." };
      }
      if (!dataTypeRepairFor({ reason: exemplar.reason, message: exemplar.message })) {
        return { ok: false, error: "This error is not a permanent data-shape mismatch." };
      }

      const resolved = await resolveFingerprintIds(workspaceId, input.fingerprint);
      if (resolved.replays.length === 0) {
        return { ok: false, error: "No dead letters match this fingerprint anymore." };
      }

      try {
        const result = await withTransaction(async (client) => {
          const muted = await client.query(
            `SELECT 1 FROM dead_letter_mutes
              WHERE workspace_id = $1 AND fingerprint = $2 AND (until IS NULL OR until > now())
              LIMIT 1`,
            [workspaceId, input.fingerprint],
          );
          if (muted.rowCount) throw new Error("repair_fingerprint_muted");

          const routeRes = await client.query<RouteForRepair>(
            `SELECT id, filter_expression, transform_script,
                    pipeline_graph::text AS pipeline_graph
               FROM routes
              WHERE id = $1 AND workspace_id = $2
              FOR UPDATE`,
            [exemplar.route_id, workspaceId],
          );
          const route = routeRes.rows[0];
          if (!route) throw new Error("repair_route_not_found");
          const destinationRes = await client.query<{ destination_id: string }>(
            `SELECT destination_id FROM route_destinations WHERE route_id = $1 ORDER BY destination_id`,
            [route.id],
          );
          const destinationIds = destinationRes.rows.map((row) => row.destination_id);
          const attachedDestinationIds = new Set(destinationIds);
          if (!attachedDestinationIds.has(exemplar.destination_id!)) {
            throw new Error("repair_destination_detached");
          }

          const currentGraph: PipelineGraph = route.pipeline_graph
            ? parsePipelineGraph(route.pipeline_graph, {
                attached_destination_ids: attachedDestinationIds,
                allow_duplicate_destination_nodes: true,
              })
            : synthesizeLegacyPipeline({
                filterExpression: route.filter_expression,
                transformScript: route.transform_script,
                destinationIds,
              });
          const repaired = addRepairToPipeline({
            graph: currentGraph,
            destinationId: exemplar.destination_id!,
            repair,
            nodeIdSeed: prefixedId("fix").replace(/[^A-Za-z0-9_-]/g, ""),
            attachedDestinationIds,
          });
          if (repaired.changed || route.pipeline_graph === null) {
            await client.query(
              `UPDATE routes
                  SET pipeline_graph = $1::jsonb,
                      filter_expression = NULL,
                      transform_script = NULL,
                      updated_at = now()
                WHERE id = $2 AND workspace_id = $3`,
              [JSON.stringify(repaired.graph), route.id, workspaceId],
            );
          }

          const replay = await enqueueFingerprintReplays(client, {
            workspaceId,
            userId: actorUserId,
            fingerprint: input.fingerprint,
            resolved,
          });
          await audit({
            action: "dead_letter.repaired_and_retried",
            targetType: "dead_letter_fingerprint",
            targetId: input.fingerprint,
            metadata: {
              route_id: route.id,
              destination_id: exemplar.destination_id,
              repair,
              pipeline_changed: repaired.changed || route.pipeline_graph === null,
              replay_count: replay.queued,
              skipped: replay.skipped,
              truncated: resolved.truncated,
            },
          }, client);
          return replay;
        });
        updateTag(cacheTags.routes(workspaceId));
        if (result.queued === 0) {
          return {
            ok: true,
            queued: 0,
            notice: "Fix applied. Those deliveries already have a replay in flight.",
          };
        }
        let notice = `Fix applied and ${result.queued} replay${result.queued === 1 ? "" : "s"} queued`;
        if (result.skipped > 0) notice += ` (${result.skipped} already in flight)`;
        if (resolved.truncated) notice += "; run the fix again after this batch to catch the remainder";
        return { ok: true, queued: result.queued, notice: `${notice}.` };
      } catch (err) {
        console.error("[applyFingerprintRepair] failed:", err);
        return {
          ok: false,
          error: err instanceof Error ? humanRepairError(err.message) : "Could not apply this fix.",
        };
      }
    },
  );
}

/**
 * Preserve fractional values by widening the live BigQuery destination column
 * before replaying. Unlike applyFingerprintRepair, this does not rewrite the
 * route payload. The client supplies no dataset, table, path, or target type:
 * every mutation input is re-derived from the workspace-scoped dead letter,
 * current route binding, and live tables.get schema to prevent confused-deputy
 * writes against another destination field.
 */
export async function applyFingerprintSchemaRepair(
  input: ApplyInboxSchemaRepairInput,
): Promise<ApplyInboxRepairResult> {
  return withWorkspaceMutation<ApplyInboxRepairResult>(
    { billing: "replay", gateError: (error) => ({ ok: false, error }) },
    async ({ workspaceId, actorUserId, audit, tags }) => {
      const exemplar = await loadRepairExemplar(workspaceId, input.exemplarId, input.fingerprint);
      if (!exemplar) return { ok: false, error: "This error is no longer active. Refresh the Inbox." };
      if (!exemplar.route_id || !exemplar.destination_id) {
        return { ok: false, error: "Axel could not identify the route and destination for this error." };
      }
      if (!dataTypeRepairFor({ reason: exemplar.reason, message: exemplar.message })) {
        return { ok: false, error: "This error is not a permanent data-shape mismatch." };
      }

      let schemaRepair: BigQuerySchemaRepairPreview | null;
      try {
        const proposal = selectRepairProposalForDeliveryError(
          exemplar.message,
          repairProposalsFromMessage(exemplar.message),
        ) ?? await diagnoseLegacyRepair(exemplar, workspaceId);
        if (!proposal) {
          return { ok: false, error: "Axel could not confirm the destination field to change." };
        }
        schemaRepair = await previewBigQuerySchemaRepair(
          workspaceId,
          exemplar.route_id,
          exemplar.destination_id,
          proposal,
        );
      } catch (err) {
        console.error("[applyFingerprintSchemaRepair] preparation failed:", err);
        return {
          ok: false,
          error: humanRepairError(
            err instanceof Error ? err.message : "Could not inspect the current BigQuery schema.",
          ),
        };
      }
      if (!schemaRepair) {
        return {
          ok: false,
          error: "This column is no longer eligible for the safe INT64-to-FLOAT64 change. Refresh and inspect the latest schema.",
        };
      }

      const resolved = await resolveFingerprintIds(workspaceId, input.fingerprint);
      if (resolved.replays.length === 0) {
        return { ok: false, error: "No dead letters match this fingerprint anymore." };
      }
      const muted = await db().query(
        `SELECT 1 FROM dead_letter_mutes
          WHERE workspace_id = $1 AND fingerprint = $2 AND (until IS NULL OR until > now())
          LIMIT 1`,
        [workspaceId, input.fingerprint],
      );
      if (muted.rowCount) return { ok: false, error: humanRepairError("repair_fingerprint_muted") };

      let schemaChange: Awaited<ReturnType<typeof widenBigQueryDestinationField>>;
      try {
        schemaChange = await widenBigQueryDestinationField({
          destinationId: exemplar.destination_id,
          workspaceId,
          dataset: schemaRepair.dataset,
          table: schemaRepair.table,
          fieldPath: schemaRepair.fieldPath,
          fromType: schemaRepair.fromType,
          toType: schemaRepair.toType,
        });
      } catch (err) {
        console.error("[applyFingerprintSchemaRepair] BigQuery change failed:", err);
        return {
          ok: false,
          error: humanRepairError(err instanceof Error ? err.message : "Could not change the BigQuery column."),
        };
      }

      try {
        const replay = await withTransaction(async (client) => {
          const mutedAgain = await client.query(
            `SELECT 1 FROM dead_letter_mutes
              WHERE workspace_id = $1 AND fingerprint = $2 AND (until IS NULL OR until > now())
              LIMIT 1`,
            [workspaceId, input.fingerprint],
          );
          if (mutedAgain.rowCount) throw new Error("repair_fingerprint_muted");

          const liveTarget = await loadBigQueryRepairTarget(
            workspaceId,
            exemplar.route_id!,
            exemplar.destination_id!,
            client,
          );
          if (!liveTarget) throw new Error("repair_destination_detached");
          if (liveTarget.dataset !== schemaRepair.dataset || liveTarget.table !== schemaRepair.table) {
            throw new Error("repair_destination_binding_changed");
          }

          const queued = await enqueueFingerprintReplays(client, {
            workspaceId,
            userId: actorUserId,
            fingerprint: input.fingerprint,
            resolved,
          });
          await audit({
            action: "dead_letter.destination_schema_repaired_and_retried",
            targetType: "dead_letter_fingerprint",
            targetId: input.fingerprint,
            metadata: {
              route_id: exemplar.route_id,
              destination_id: exemplar.destination_id,
              project_id: schemaChange.projectId,
              dataset: schemaChange.dataset,
              table: schemaChange.table,
              field_path: schemaChange.fieldPath,
              from_type: schemaChange.fromType,
              to_type: schemaChange.toType,
              schema_changed: schemaChange.changed,
              replay_count: queued.queued,
              skipped: queued.skipped,
              truncated: resolved.truncated,
            },
          }, client);
          return queued;
        });

        tags("destinations", "routes", "deadLetters", "replays");
        const prefix = schemaChange.changed
          ? `${schemaChange.fieldPath} now uses FLOAT64 in BigQuery`
          : `${schemaChange.fieldPath} already uses FLOAT64 in BigQuery`;
        if (replay.queued === 0) {
          return {
            ok: true,
            queued: 0,
            notice: `${prefix}. Those deliveries already have a replay in flight.`,
          };
        }
        let notice = `${prefix}; ${replay.queued} replay${replay.queued === 1 ? "" : "s"} queued`;
        if (replay.skipped > 0) notice += ` (${replay.skipped} already in flight)`;
        if (resolved.truncated) notice += "; run the fix again after this batch to catch the remainder";
        return { ok: true, queued: replay.queued, notice: `${notice}.` };
      } catch (err) {
        console.error("[applyFingerprintSchemaRepair] replay enqueue failed:", err);
        return {
          ok: false,
          error: `${schemaChange.fieldPath} now uses FLOAT64, but Axel could not queue the replays. ${humanRepairError(err instanceof Error ? err.message : "Use Retry from the Inbox.")}`,
        };
      }
    },
  );
}

export async function retryFingerprint(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({ billing: "replay" }, async ({ workspaceId, actorUserId, audit }) => {
    const fingerprint = formValue(formData, "fingerprint");
    if (!fingerprint) return { error: "fingerprint is required." };

    // Respect an active mute on this fingerprint — retrying a fingerprint the
    // operator silenced (its destination is still broken) just re-floods the
    // dead-letter queue (audit: replay paths ignored mutes).
    const muted = await db().query(
      `SELECT 1 FROM dead_letter_mutes
        WHERE workspace_id = $1 AND fingerprint = $2 AND (until IS NULL OR until > now())
        LIMIT 1`,
      [workspaceId, fingerprint],
    );
    if (muted.rowCount) {
      return { error: "This fingerprint is muted. Unmute it before retrying." };
    }

    const { replays, truncated } = await resolveFingerprintIds(
      workspaceId,
      fingerprint,
    );
    if (replays.length === 0) {
      return { error: "No dead letters match this fingerprint anymore." };
    }

    const { queued, skipped } = await enqueueFingerprintReplays(db(), {
      workspaceId,
      userId: actorUserId,
      fingerprint,
      resolved: { ids: [], replays, truncated },
    });

    await audit({
      action: "dead_letter.bulk_retried",
      targetType: "dead_letter_fingerprint",
      targetId: fingerprint,
      metadata: { replay_count: queued, skipped, truncated },
    });

    if (queued === 0) {
      return {
        notice: skipped > 0
          ? "Those letters already have a replay in flight — nothing new to queue."
          : "No dead letters match this fingerprint anymore.",
      };
    }
    let notice = `Queued ${queued} replay${queued === 1 ? "" : "s"}`;
    if (skipped > 0) notice += ` (${skipped} already in flight, skipped)`;
    if (truncated) notice += "; this fingerprint exceeds the scan cap, so run Retry again to catch the rest";
    notice += " — they'll surface back as deliveries within seconds.";
    return { notice };
  });
}

interface RepairExemplar {
  id: string;
  reason: string;
  message: string;
  route_id: string | null;
  destination_id: string | null;
  r2_key: string;
}

interface RouteForRepair {
  id: string;
  filter_expression: string | null;
  transform_script: string | null;
  pipeline_graph: string | null;
}

interface BigQueryRepairTarget {
  projectId: string;
  dataset: string;
  table: string;
}

async function loadRepairExemplar(
  workspaceId: string,
  exemplarId: string,
  fingerprint: string,
): Promise<RepairExemplar | null> {
  if (!/^\d+$/.test(exemplarId) || !fingerprint) return null;
  const result = await db().query<RepairExemplar>(
    `SELECT id::text, reason, message, route_id,
            NULLIF(destination_id, '') AS destination_id, r2_key
       FROM dead_letters
      WHERE id = $1::bigint
        AND workspace_id = $2
        AND resolved_at IS NULL
      LIMIT 1`,
    [exemplarId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const actual = await fingerprintFor({
    route_id: row.route_id,
    reason: row.reason,
    message: row.message,
  });
  return actual === fingerprint ? row : null;
}

async function previewBigQuerySchemaRepair(
  workspaceId: string,
  routeId: string,
  destinationId: string,
  proposal: InboxRepairProposal,
): Promise<BigQuerySchemaRepairPreview | null> {
  if (proposal.issue.kind !== "type_conflict") return null;
  const expected = normalizeIssueScalarType(proposal.issue.expected);
  const existing = normalizeIssueScalarType(proposal.issue.existing);
  if (expected !== "FLOAT64" || existing !== "INT64") return null;

  const target = await loadBigQueryRepairTarget(workspaceId, routeId, destinationId);
  if (!target) return null;
  const live = await introspectBigQueryDestination(destinationId, workspaceId, {
    dataset: target.dataset,
    table: target.table,
  });
  if (live.kind === "missing") return null;
  const field = findBigQueryField(live.fields, proposal.issue.path);
  if (!field) return null;
  const liveType = normalizeBqType(field.type);
  if (liveType !== "INT64" && liveType !== "FLOAT64") return null;

  const plan = planBigQueryFieldTypeChange({
    projectId: target.projectId,
    dataset: target.dataset,
    table: target.table,
    fields: live.fields,
    fieldPath: proposal.issue.path,
    fromType: "INT64",
    toType: "FLOAT64",
  });
  return {
    kind: "bigquery_widen",
    dataset: target.dataset,
    table: target.table,
    fieldPath: proposal.issue.path,
    fromType: "INT64",
    toType: "FLOAT64",
    status: plan.changed ? "needed" : "already_applied",
  };
}

async function loadBigQueryRepairTarget(
  workspaceId: string,
  routeId: string,
  destinationId: string,
  client: Queryable = db(),
): Promise<BigQueryRepairTarget | null> {
  const result = await client.query<{
    binding: unknown;
    config: unknown;
    type: string;
  }>(
    `SELECT rd.binding, d.config, d.type
       FROM route_destinations rd
       JOIN destinations d
         ON d.id = rd.destination_id
        AND d.workspace_id = $3
      WHERE rd.route_id = $1
        AND rd.destination_id = $2
      LIMIT 1`,
    [routeId, destinationId, workspaceId],
  );
  const row = result.rows[0];
  if (!row || row.type !== "bigquery") return null;
  const config = recordValue(row.config);
  const target = { ...config, ...recordValue(row.binding) };
  const projectId = typeof config.project_id === "string" ? config.project_id.trim() : "";
  const dataset = typeof target.dataset === "string" ? target.dataset.trim() : "";
  const table = typeof target.table === "string" ? target.table.trim() : "";
  return projectId && dataset && table ? { projectId, dataset, table } : null;
}

function normalizeIssueScalarType(value: string): string {
  return normalizeBqType(value.replace(/^(?:NULLABLE|REQUIRED|REPEATED)\s+/i, ""));
}

async function diagnoseLegacyRepair(
  exemplar: RepairExemplar,
  workspaceId: string,
): Promise<InboxRepairProposal | null> {
  if (!exemplar.route_id || !exemplar.destination_id) return null;
  const [routeRes, destinationsRes] = await Promise.all([
    db().query<RouteForRepair>(
      `SELECT id, filter_expression, transform_script,
              pipeline_graph::text AS pipeline_graph
         FROM routes
        WHERE id = $1 AND workspace_id = $2
        LIMIT 1`,
      [exemplar.route_id, workspaceId],
    ),
    db().query<{
      destination_id: string;
      binding: unknown;
      type: string;
      config: unknown;
    }>(
      `SELECT rd.destination_id, rd.binding, d.type, d.config
         FROM route_destinations rd
         JOIN destinations d ON d.id = rd.destination_id AND d.workspace_id = $2
        WHERE rd.route_id = $1`,
      [exemplar.route_id, workspaceId],
    ),
  ]);
  const route = routeRes.rows[0];
  const destination = destinationsRes.rows.find((row) => row.destination_id === exemplar.destination_id);
  if (!route || !destination || destination.type !== "bigquery") return null;
  const binding = {
    ...recordValue(destination.config),
    ...recordValue(destination.binding),
  };
  const dataset = typeof binding.dataset === "string" ? binding.dataset.trim() : "";
  const table = typeof binding.table === "string" ? binding.table.trim() : "";
  if (!dataset || !table) return null;
  const payload = await fetchPayloadForR2Key(exemplar.r2_key);
  if (payload === null) return null;
  const attached = new Set(destinationsRes.rows.map((row) => row.destination_id));
  let outgoing: unknown;
  if (route.pipeline_graph) {
    const graph = parsePipelineGraph(route.pipeline_graph, {
      attached_destination_ids: attached,
      allow_duplicate_destination_nodes: true,
    });
    outgoing = executeGraph(payload, graph).deliveries.find(
      (delivery) => delivery.destination_id === exemplar.destination_id,
    )?.payload;
    if (outgoing === undefined) return null;
  } else {
    if (route.filter_expression && !runFilter(payload, parseFilter(route.filter_expression))) return null;
    outgoing = route.transform_script
      ? runTransform(payload, parseTransform(route.transform_script))
      : payload;
  }

  const mode = bigQueryModeForBinding(destination.binding == null ? null : binding) as BigQueryWriteMode;
  const payloadColumn = typeof binding.payload_column === "string" ? binding.payload_column : "payload";
  // Ensure the event can be shaped before paying for the table metadata call.
  if (bigQueryRowForEvent(outgoing, mode, payloadColumn) === null) return null;
  const current = await introspectBigQueryDestination(exemplar.destination_id, workspaceId, {
    dataset,
    table,
  });
  if (current.kind === "missing") return null;
  const issues = compareBigQuerySchemas(
    expectedBigQuerySchema([outgoing], mode, payloadColumn),
    current.fields,
  ).conflicts;
  const proposals = issues.flatMap((issue) => {
    const proposal = repairProposalFromIssue(issue);
    return proposal ? [proposal] : [];
  });
  if (proposals.length === 0) return null;
  return selectRepairProposalForDeliveryError(exemplar.message, proposals);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function enqueueFingerprintReplays(
  client: Queryable,
  input: {
    workspaceId: string;
    userId: string;
    fingerprint: string;
    resolved: DeadLetterIdsForFingerprint;
  },
): Promise<{ queued: number; skipped: number }> {
  const replays = input.resolved.replays;
  if (replays.length === 0) return { queued: 0, skipped: 0 };
  // One set-based enqueue through the shared tail (in-flight dedupe guard for
  // double-clicks lives there). Both callers already checked the fingerprint's
  // mute BEFORE calling — the candidate rows carry a NULL fingerprint, which
  // never matches a mute, so the tail's mute check is a no-op here. The
  // callers write their own richer audit rows (bulk_retried /
  // repaired_and_retried), so no audit option is passed.
  const values: string[] = [];
  const params: unknown[] = [];
  let index = 1;
  for (const replay of replays) {
    values.push(
      `(${paramRef(index++)}::text, ${paramRef(index++)}::text, ${paramRef(index++)}::text, ${paramRef(index++)}::text, ${paramRef(index++)}::text)`,
    );
    params.push(replay.event_id, replay.source_id, replay.r2_key, replay.route_id, replay.reason);
  }
  const result = await enqueueReplays(client, {
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    reason: null,
    candidates: {
      sql: `SELECT v.event_id, v.source_id, v.r2_key, 'route' AS scope, v.route_id,
                   NULL::text AS destination_id, v.failure_reason, NULL::text AS fingerprint
              FROM (VALUES ${values.join(", ")}) AS v(event_id, source_id, r2_key, route_id, failure_reason)`,
      params,
    },
  });
  return { queued: result.queued, skipped: replays.length - result.queued };
}

function paramRef(i: number): string {
  return `$${i}`;
}
