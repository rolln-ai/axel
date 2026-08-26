"use server";

import { revalidatePath } from "next/cache";
import { db } from "../db";
import { enqueueReplays } from "../replay-enqueue";
import { requireActiveWorkspace, replayBillingGateError, requireWritableRole } from "../auth-guards";
import { fetchPayloadForR2Key } from "../sample-payload";
import { requireSession, type CurrentSession } from "../session";
import {
  approvePatch as approveExplainPatch,
  explainFailure,
  FixturesFailedError,
  type ApprovalInput,
  type ApprovalResult,
  type FailureContext,
} from "./explain";
import type { GeneratedFilter, GeneratedTransform } from "./codegen";
import { inferDataContract } from "./inference";
import type { InferredDataContract } from "./inference";
import {
  appendDataContractVersion,
  createDataContract,
  deleteDataContract,
  findActiveDataContractForSource,
  getDataContract,
  getDataContractVersion,
  resolveDriftEvent,
  updateDataContractStatus,
  type DataContractStatus,
} from "./repository";
import {
  sampleSourceEvents,
  sampleSourceEventsPreferIndex,
  type SampledEvent,
} from "./sampler";

/**
 * Lightweight session shape used by the pure orchestration functions. The
 * server-action wrappers fetch the real `CurrentSession`; the pure
 * functions only need workspace + role + actor user_id, so vitest can pass
 * a hand-rolled minimum.
 */
export interface ActionSession {
  user: { id: string };
  activeWorkspace: { workspace_id: string; role: CurrentSession["activeWorkspace"]["role"] };
}

export interface DataContractsActionState {
  error?: string;
  notice?: string;
  data?: {
    dataContractId?: string;
    versionId?: string;
  };
}

/**
 * Internal hooks. The default values come from the production modules but
 * each can be replaced — that's how vitest exercises this action without
 * standing up ClickHouse / R2 / OpenRouter.
 */
export interface UnderstandSourceDeps {
  sampler?: typeof sampleSourceEvents;
  inferer?: typeof inferDataContract;
  creator?: typeof createDataContract;
  versionAppender?: typeof appendDataContractVersion;
}

function fv(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function defaultDataContractName(sourceName: string | null, sourceId: string): string {
  const base = (sourceName ?? sourceId).slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${base} — ${stamp}`;
}

/**
 * Pure orchestration for "Understand source" — no session lookup, no
 * Next cache calls. The exported `understandSourceAction` wrapper does
 * those; this body is what tests target.
 */
export async function understandSourceImpl(
  session: ActionSession,
  formData: FormData,
  deps: UnderstandSourceDeps = {},
): Promise<DataContractsActionState> {
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const sourceId = fv(formData, "source_id");
  if (!sourceId) return { error: "Missing source id." };
  const sourceName = fv(formData, "source_name") || null;
  const customName = fv(formData, "name");

  // Prefer the exhaustive event-type index so a contract created against a
  // busy source captures every distinct type up front, not just whatever
  // random sampling happened to catch. Falls back to random sampling for
  // sources without an indexed event_type yet.
  const sampler = deps.sampler ?? sampleSourceEventsPreferIndex;
  const inferer = deps.inferer ?? inferDataContract;
  const creator = deps.creator ?? createDataContract;
  const versionAppender = deps.versionAppender ?? appendDataContractVersion;

  let samples: SampledEvent[];
  try {
    samples = await sampler(workspaceId, sourceId);
  } catch (err) {
    return {
      error: `Couldn't sample events: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    };
  }
  if (samples.length === 0) {
    return {
      error:
        "No events available to sample. Send at least one event to this source and try again.",
    };
  }

  let inferred: Awaited<ReturnType<typeof inferDataContract>>;
  try {
    inferred = await inferer(samples);
  } catch (err) {
    return {
      error: `Inference failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  let dataContractId: string;
  let versionId: string;
  try {
    const map = await creator({
      workspaceId,
      sourceId,
      name: customName || defaultDataContractName(sourceName, sourceId),
      createdByUserId: session.user.id,
    });
    dataContractId = map.id;
    const version = await versionAppender({
      dataContractId: map.id,
      workspaceId,
      inferredSchema: inferred,
      modelMetadata: inferred.model_metadata,
      createdByUserId: session.user.id,
    });
    versionId = version.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message.includes("data_contracts_workspace_lower_name_idx")) {
      return {
        error:
          "An Data Contract with this name already exists in this workspace. Pick a different name.",
      };
    }
    return { error: `Could not create the Data Contract: ${message}` };
  }

  return {
    notice: `Created draft Data Contract from ${samples.length} sampled events.`,
    data: { dataContractId, versionId },
  };
}

export async function understandSourceAction(
  _prev: DataContractsActionState,
  formData: FormData,
): Promise<DataContractsActionState> {
  const session = await requireSession();
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const result = await understandSourceImpl(session, formData);
  if (!result.error) {
    const sourceId = fv(formData, "source_id");
    revalidatePath(`/sources/${sourceId}`);
    revalidatePath("/data-contracts");
  }
  return result;
}

export interface AnnotationsInput {
  /** map cluster_id -> new name (filtered to non-empty). */
  cluster_renames?: Record<string, string>;
  /** map path -> { ignored?, sensitive_override? }. */
  field_annotations?: Record<
    string,
    { ignored?: boolean; sensitive_override?: boolean }
  >;
}

export interface SaveAnnotationsDeps {
  versionGetter?: typeof getDataContractVersion;
  versionAppender?: typeof appendDataContractVersion;
  mapGetter?: typeof getDataContract;
}

/**
 * Pure orchestration for "save annotations" — see understandSourceImpl
 * for why this is split out from the server-action wrapper.
 */
export async function saveAnnotationsImpl(
  session: ActionSession,
  dataContractId: string,
  input: AnnotationsInput,
  deps: SaveAnnotationsDeps = {},
): Promise<DataContractsActionState> {
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const versionGetter = deps.versionGetter ?? getDataContractVersion;
  const versionAppender = deps.versionAppender ?? appendDataContractVersion;
  const mapGetter = deps.mapGetter ?? getDataContract;

  const map = await mapGetter(dataContractId, workspaceId);
  if (!map) return { error: "Data Contract not found." };
  if (!map.current_version_id) {
    return { error: "Data Contract has no version yet." };
  }
  const current = await versionGetter(map.current_version_id, workspaceId);
  if (!current) return { error: "Current Data Contract version not found." };

  const schema = current.inferred_schema as Record<string, unknown>;
  const nextSchema = applyClusterRenames(schema, input.cluster_renames ?? {});
  const nextAnnotations = mergeAnnotations(
    (current.field_annotations ?? {}) as Record<
      string,
      { ignored?: boolean; sensitive_override?: boolean }
    >,
    input.field_annotations ?? {},
  );

  const version = await versionAppender({
    dataContractId,
    workspaceId,
    inferredSchema: nextSchema,
    fieldAnnotations: nextAnnotations,
    generatedFilter: current.generated_filter,
    generatedTransform: current.generated_transform,
    transformLanguage: current.transform_language,
    destinationMapping: current.destination_mapping,
    modelMetadata: current.model_metadata,
    createdByUserId: session.user.id,
  });

  return {
    notice: "Saved as a new draft version.",
    data: { dataContractId, versionId: version.id },
  };
}

export async function saveAnnotationsAction(
  dataContractId: string,
  input: AnnotationsInput,
): Promise<DataContractsActionState> {
  const session = await requireSession();
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const result = await saveAnnotationsImpl(session, dataContractId, input);
  if (!result.error) revalidatePath(`/data-contracts/${dataContractId}`);
  return result;
}

function applyClusterRenames(
  schema: Record<string, unknown>,
  renames: Record<string, string>,
): Record<string, unknown> {
  if (Object.keys(renames).length === 0) return schema;
  const eventTypes = Array.isArray(schema.event_types)
    ? (schema.event_types as Array<Record<string, unknown>>).map((c) => {
        const id =
          typeof c.cluster_id === "string" ? c.cluster_id : undefined;
        const next = id && renames[id];
        return next && next.trim().length > 0 && next.length < 80
          ? { ...c, name: next.trim() }
          : c;
      })
    : schema.event_types;
  return { ...schema, event_types: eventTypes };
}

function mergeAnnotations(
  base: Record<string, { ignored?: boolean; sensitive_override?: boolean }>,
  diff: Record<string, { ignored?: boolean; sensitive_override?: boolean }>,
): Record<string, { ignored?: boolean; sensitive_override?: boolean }> {
  const out: Record<
    string,
    { ignored?: boolean; sensitive_override?: boolean }
  > = { ...base };
  for (const [path, ann] of Object.entries(diff)) {
    const existing = out[path] ?? {};
    const merged = { ...existing, ...ann };
    // Strip falsy/no-op annotations so the column stays compact.
    if (!merged.ignored && !merged.sensitive_override) {
      delete out[path];
    } else {
      out[path] = merged;
    }
  }
  return out;
}

export interface StatusActionDeps {
  statusUpdater?: typeof updateDataContractStatus;
}

export async function setDataContractStatusImpl(
  session: ActionSession,
  dataContractId: string,
  status: DataContractStatus,
  deps: StatusActionDeps = {},
): Promise<DataContractsActionState> {
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const statusUpdater = deps.statusUpdater ?? updateDataContractStatus;
  try {
    await statusUpdater(dataContractId, workspaceId, status);
  } catch (err) {
    console.error("setDataContractStatus failed", err);
    return { error: "Could not change the Data Contract status. Try again." };
  }
  return { notice: `Status set to ${status}.` };
}

export async function setDataContractStatusAction(
  dataContractId: string,
  status: DataContractStatus,
): Promise<DataContractsActionState> {
  const session = await requireSession();
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const result = await setDataContractStatusImpl(session, dataContractId, status);
  if (!result.error) {
    revalidatePath(`/data-contracts/${dataContractId}`);
    revalidatePath("/data-contracts");
  }
  return result;
}

export interface DeleteActionDeps {
  deleter?: typeof deleteDataContract;
}

export async function deleteDataContractImpl(
  session: ActionSession,
  dataContractId: string,
  deps: DeleteActionDeps = {},
): Promise<DataContractsActionState> {
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const deleter = deps.deleter ?? deleteDataContract;
  const removed = await deleter(dataContractId, workspaceId);
  if (!removed) {
    return { error: "Data Contract not found in this workspace." };
  }
  return {
    notice: "Data Contract deleted.",
    data: { dataContractId },
  };
}

export async function deleteDataContractAction(
  dataContractId: string,
): Promise<DataContractsActionState> {
  const session = await requireSession();
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const result = await deleteDataContractImpl(session, dataContractId);
  if (!result.error) {
    // Detail page goes 404 after this; the list reflects the removal.
    revalidatePath(`/data-contracts/${dataContractId}`);
    revalidatePath("/data-contracts");
    revalidatePath("/sources", "layout");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Drift resolution
// ---------------------------------------------------------------------------

export interface ResolveDriftDeps {
  resolver?: typeof resolveDriftEvent;
}

export async function resolveDriftImpl(
  session: ActionSession,
  driftId: string,
  deps: ResolveDriftDeps = {},
): Promise<DataContractsActionState> {
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const resolver = deps.resolver ?? resolveDriftEvent;
  await resolver(driftId, workspaceId, session.user.id);
  return { notice: "Drift event marked resolved." };
}

export async function resolveDriftAction(
  driftId: string,
  sourceId?: string,
): Promise<DataContractsActionState> {
  const session = await requireSession();
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const result = await resolveDriftImpl(session, driftId);
  if (!result.error) {
    if (sourceId) revalidatePath(`/sources/${sourceId}`);
    revalidatePath("/data-contracts");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Investigate-failure approval flow (AXE-49 UI wrap-up).
// ---------------------------------------------------------------------------

export interface InvestigationApprovalState extends DataContractsActionState {
  result?: ApprovalResult;
  /** Set when the fixture gate refused activation — the UI surfaces the
   *  failed fixtures so an operator can edit the patch and retry. */
  fixture_failures?: { passed: number; failed: number; total: number };
}

export interface ApprovePatchActionDeps {
  approvePatch?: typeof approveExplainPatch;
}

export async function approvePatchImpl(
  session: ActionSession,
  input: Omit<ApprovalInput, "userId" | "workspaceId"> & { workspaceId?: never },
  deps: ApprovePatchActionDeps = {},
): Promise<InvestigationApprovalState> {
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const workspaceId = session.activeWorkspace.workspace_id;
  const approve = deps.approvePatch ?? approveExplainPatch;
  try {
    const result = await approve({
      workspaceId,
      userId: session.user.id,
      dataContractId: input.dataContractId,
      patch: input.patch,
      currentVersion: input.currentVersion,
      failedDeliveries: input.failedDeliveries,
      samples: input.samples,
    });
    return {
      notice: `Patch applied. Created version with ${result.fixture_result.passed}/${result.fixture_result.total} fixtures passing. Queued ${result.replays_queued} replay${result.replays_queued === 1 ? "" : "s"}.`,
      data: {
        dataContractId: input.dataContractId,
        versionId: result.new_version_id,
      },
      result,
    };
  } catch (err) {
    if (err instanceof FixturesFailedError) {
      return {
        error: `Activation gate refused: ${err.result.failed}/${err.result.total} fixtures failed. Edit the patch and try again.`,
        fixture_failures: {
          passed: err.result.passed,
          failed: err.result.failed,
          total: err.result.total,
        },
      };
    }
    return {
      error: `Approval failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function approvePatchAction(
  input: Omit<ApprovalInput, "userId" | "workspaceId">,
): Promise<InvestigationApprovalState> {
  const session = await requireSession();
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const result = await approvePatchImpl(session, input);
  if (!result.error) {
    revalidatePath(`/data-contracts/${input.dataContractId}`);
    revalidatePath("/deliveries");
  }
  return result;
}

// ---------------------------------------------------------------------------
// One-click "Fix with AI" from the dashboard Activity card.
//
// The Activity card lists failure reasons grouped by dl.reason. For the
// AI-fixable reasons (DSL engine failures — declarative_engine_error and
// the granular transform_* / filter_* sub-reasons), an operator should
// be able to click one button that:
//
//   1. Picks the latest failed delivery for that reason.
//   2. Loads the source's Data Contract + the failed payload + recent samples.
//   3. Calls explainFailure to get a proposed patch.
//   4. Calls approvePatchImpl to create a new DataContractVersion + replay
//      that one delivery (the same flow the InvestigationApprovalForm
//      uses on /investigate, just done automatically).
//   5. Queues replays for the rest of the dl rows matching that reason
//      so the whole backlog drains, not just the seed event.
//   6. Returns a structured message so the dashboard button can show
//      "Fixed via emv_… · replayed N" without redirecting.
//
// If any step refuses (no Data Contract yet, model returned patch_kind=none,
// fixture gate refused), the action returns an error with a deep-link
// to the investigate page so the operator can review manually.
// ---------------------------------------------------------------------------

export interface QuickFixState {
  error?: string;
  notice?: string;
  /** Deep-link the UI can show next to an error so the operator can
   *  fall through to manual review on /investigate. */
  fallback_href?: string;
  data?: {
    versionId?: string;
    dataContractId?: string;
    replays_queued?: number;
  };
}

// router_processing_failed used to be in this set, but it's the outer
// catch in router-edge — it fires before any DSL evaluation runs, so
// the AI rewrite path can't help. The granular DSL reasons emitted by
// RouteEngineError ("transform_*", "filter_*") and the fallback
// "declarative_engine_error" are the only reasons whose root cause is
// actually a DSL bug the model can patch.
const QUICK_FIX_REASONS = new Set([
  "declarative_engine_error",
]);
const QUICK_FIX_REASON_PREFIXES = ["transform_", "filter_"];

function isQuickFixReason(reason: string): boolean {
  if (QUICK_FIX_REASONS.has(reason)) return true;
  return QUICK_FIX_REASON_PREFIXES.some((p) => reason.startsWith(p));
}

const QUICK_FIX_REPLAY_CAP = 2000;

export async function quickFixWithAiAction(
  _state: QuickFixState,
  formData: FormData,
): Promise<QuickFixState> {
  const session = await requireSession();
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  // This action enqueues up to QUICK_FIX_REPLAY_CAP replays, so it must pass the
  // same active-workspace + billing gate as the other replay entry points
  // (requestReplay / requestReplayAllUnresolved). Without it a suspended or
  // quota-exceeded workspace could mass-enqueue billable replays via the AI
  // quick-fix path (audit).
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const billingError = await replayBillingGateError(session.activeWorkspace.workspace_id);
  if (billingError) return { error: billingError };

  const reason = fv(formData, "reason");
  if (!reason) return { error: "reason is required." };
  if (!isQuickFixReason(reason)) {
    return {
      error: `Reason "${reason}" isn't AI-fixable. Use the per-reason action instead.`,
    };
  }

  const workspaceId = session.activeWorkspace.workspace_id;

  // Pick the latest unresolved dead-letter for this reason. The
  // `resolved_at IS NULL` matches repositories.ts so we don't seed the AI on
  // a row that's already been replayed successfully.
  const seedRes = await db().query<{
    id: string;
    event_id: string;
    source_id: string;
    route_id: string;
    r2_key: string;
    message: string | null;
    errored_at: string;
  }>(
    `SELECT dl.id::text AS id,
            dl.event_id, dl.source_id, dl.route_id, dl.r2_key,
            dl.message,
            dl.errored_at::text AS errored_at
      FROM dead_letters dl
      WHERE dl.workspace_id = $1
        AND dl.reason = $2
        AND dl.resolved_at IS NULL
      ORDER BY dl.errored_at DESC
      LIMIT 1`,
    [workspaceId, reason],
  );
  const seed = seedRes.rows[0];
  if (!seed) {
    return { notice: "No unresolved failures matching that reason." };
  }

  const investigateHref = `/deliveries/${seed.id}/investigate`;

  const mapWithVersion = await findActiveDataContractForSource(workspaceId, seed.source_id);
  if (!mapWithVersion) {
    return {
      error:
        "Source has no active Data Contract — AI fix needs one. Open the source to set it up.",
      fallback_href: `/sources/${seed.source_id}`,
    };
  }

  const [failedPayload, samples] = await Promise.all([
    fetchPayloadForR2Key(seed.r2_key).catch(() => null),
    sampleSourceEvents(workspaceId, seed.source_id, { maxEvents: 30 }).catch(
      () => [] as SampledEvent[],
    ),
  ]);
  if (failedPayload === null) {
    return {
      error: "Couldn't fetch the failed payload from storage. Try again or use manual review.",
      fallback_href: investigateHref,
    };
  }

  const inferred = mapWithVersion.version.inferred_schema as InferredDataContract;
  const currentTransform = parseTransformSerialized(mapWithVersion.version.generated_transform);
  const currentFilter = parseFilterSerialized(mapWithVersion.version.generated_filter);

  const failureContext: FailureContext = {
    data_contract_id: mapWithVersion.map.id,
    data_contract_version_id: mapWithVersion.version.id,
    inferred_schema: inferred,
    current_transform: currentTransform,
    current_filter: currentFilter,
    failed_events: [
      {
        event_id: seed.event_id,
        received_at: seed.errored_at,
        shard: 0,
        headers: {},
        payload: failedPayload,
        shape_hash: "quickfix",
      },
    ],
    response: { status: 0, body_excerpt: seed.message ?? "" },
    connector_message: seed.message ?? null,
  };

  let patch: Awaited<ReturnType<typeof explainFailure>>;
  try {
    patch = await explainFailure(failureContext);
  } catch (err) {
    return {
      error: `AI service error: ${err instanceof Error ? err.message : String(err)}`,
      fallback_href: investigateHref,
    };
  }

  if (patch.patch_kind === "none") {
    return {
      error: `AI couldn't propose a confident fix: ${patch.likely_cause}`,
      fallback_href: investigateHref,
    };
  }

  // Apply the patch (creates new DataContractVersion, runs fixture gate,
  // replays the seed dl). Reuses the same impl the manual flow uses.
  const approval = await approvePatchImpl(session, {
    dataContractId: mapWithVersion.map.id,
    patch,
    currentVersion: mapWithVersion.version,
    failedDeliveries: [
      {
        event_id: seed.event_id,
        source_id: seed.source_id,
        route_id: seed.route_id,
        r2_key: seed.r2_key,
      },
    ],
    samples,
  });
  if (approval.error) {
    return {
      error: approval.error,
      fallback_href: investigateHref,
    };
  }

  // Drain the rest of the backlog for this reason. The new transform
  // version is now active, so a replay will route through the patched
  // pipeline. Skip the seed dl since approvePatch already queued it.
  let extraQueued = 0;
  try {
    // Candidate selection stays here (oldest-first, capped, excluding the
    // seed the approval already replayed); the shared tail adds what this
    // path used to lack — the in-flight dedupe guard and the active-mute
    // check — so a quick-fix can no longer duplicate pending replays or
    // re-flood a fingerprint the operator silenced.
    const result = await enqueueReplays(db(), {
      workspaceId,
      actorUserId: session.user.id,
      reason: `quickfix_${reason}`,
      candidates: {
        sql: `SELECT dl.event_id, dl.source_id, dl.r2_key, 'route' AS scope,
                     dl.route_id, NULL::text AS destination_id, dl.reason AS failure_reason, dl.fingerprint
                FROM dead_letters dl
               WHERE dl.workspace_id = $1
                 AND dl.reason = $2
                 AND dl.id <> $3::bigint
                 AND dl.resolved_at IS NULL
               ORDER BY dl.errored_at ASC
               LIMIT $4`,
        params: [workspaceId, reason, seed.id, QUICK_FIX_REPLAY_CAP],
      },
    });
    extraQueued = result.queued;
  } catch {
    // Soft-fail: the patch landed and the seed replayed; the rest of
    // the backlog can be drained with the per-reason "Replay all"
    // button on the next render. Don't fail the action over it.
  }

  revalidatePath("/deliveries");
  revalidatePath("/dashboard");

  const totalReplays = (approval.result?.replays_queued ?? 0) + extraQueued;
  return {
    notice: `Fixed via ${approval.data?.versionId ?? "new version"} · ${totalReplays} replay${totalReplays === 1 ? "" : "s"} queued`,
    data: {
      dataContractId: approval.data?.dataContractId,
      versionId: approval.data?.versionId,
      replays_queued: totalReplays,
    },
  };
}

function parseTransformSerialized(serialized: string | null): GeneratedTransform {
  if (!serialized) return { kind: "passthrough" };
  try {
    return JSON.parse(serialized) as GeneratedTransform;
  } catch {
    return { kind: "passthrough" };
  }
}

function parseFilterSerialized(serialized: string | null): GeneratedFilter | null {
  if (!serialized) return null;
  try {
    return JSON.parse(serialized) as GeneratedFilter;
  } catch {
    return null;
  }
}
