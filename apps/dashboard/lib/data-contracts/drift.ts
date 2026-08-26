import "server-only";
import {
  clusterIdFor,
  inferDeterministic,
  type FieldSpec,
  type InferredDataContract,
} from "./inference";
import {
  appendDataContractVersion,
  getDataContractVersion,
  insertDriftEvent,
  listAllDriftWatchedDataContracts,
  listUnresolvedDriftEvents,
  type DriftCategory,
  type DataContractRow,
  type DataContractVersionRow,
  type InsertDriftInput,
} from "./repository";
import {
  sampleSourceEvents,
  sampleSourceEventsPreferIndex,
  listDistinctEventTypes,
  type SampledEvent,
} from "./sampler";
import { emitNotification, notifyOnDrift } from "../notifications";
import type { Queryable } from "../db";

/**
 * Output of the pure drift-detection pass: what categories of drift were
 * observed across the recent sample, with enough context (field_path,
 * sample_event_id, detail) to insert into `data_contract_drift_events` and
 * eventually surface in the UI.
 */
export interface DetectedDrift {
  category: DriftCategory;
  field_path: string | null;
  sample_event_id: string | null;
  detail: Record<string, unknown>;
}

/**
 * Compare the saved inferred schema against a fresh sample of events and
 * report any drift. Pure — no side effects, no DB writes. The runner
 * below feeds this into `insertDriftEvent` with workspace + data_contract +
 * version context.
 *
 * The 5 categories from the AXE-22 spec:
 *
 *   - new_event_type:        shape cluster not seen in the saved schema
 *   - missing_field:         path was required (presence=1) before, missing now
 *   - type_change:           primitive type set for a known path changed
 *   - new_sensitive_field:   newly-observed path matches sensitive heuristics
 *   - unknown_shape:         known event-type name with a high-volume new shape
 */
export function detectDrift(
  savedSchema: InferredDataContract,
  recent: SampledEvent[],
  options: { highVolumeShapeMin?: number } = {},
): DetectedDrift[] {
  if (recent.length === 0) return [];
  const incoming = inferDeterministic(recent);
  const drifts: DetectedDrift[] = [];

  // 1. new_event_type — cluster ids present in incoming, absent in saved.
  //
  //    Backward-compat: schemas saved before inference switched to
  //    type-name-based cluster ids (2026-05-18) stored
  //    `cluster_id = shape_hash` for every cluster. After deploy,
  //    incoming clusters re-key to `t:<name>` whenever a type field
  //    is present, so a naive comparison would falsely fire
  //    `new_event_type` for every known event type on the first cron
  //    pass. Build a set of saved raw-hash ids and compare against
  //    the actual shape hashes of incoming samples — if every shape
  //    hash for an incoming cluster is already known, it isn't new,
  //    just re-keyed.
  const RAW_HASH_RE = /^[0-9a-f]{8}$/;
  const savedClusterIds = new Set(savedSchema.event_types.map((c) => c.cluster_id));
  const savedRawHashes = new Set(
    savedSchema.event_types
      .map((c) => c.cluster_id)
      .filter((id) => RAW_HASH_RE.test(id)),
  );
  const incomingShapesByCluster = new Map<string, Set<string>>();
  for (const s of recent) {
    const id = clusterIdFor(s);
    let set = incomingShapesByCluster.get(id);
    if (!set) {
      set = new Set<string>();
      incomingShapesByCluster.set(id, set);
    }
    set.add(s.shape_hash);
  }
  for (const inc of incoming.event_types) {
    if (savedClusterIds.has(inc.cluster_id)) continue;
    const incShapes = incomingShapesByCluster.get(inc.cluster_id);
    if (incShapes && incShapes.size > 0 && savedRawHashes.size > 0) {
      let allKnown = true;
      for (const h of incShapes) {
        if (!savedRawHashes.has(h)) {
          allKnown = false;
          break;
        }
      }
      if (allKnown) continue;
    }
    drifts.push({
      category: "new_event_type",
      field_path: null,
      sample_event_id: inc.example_event_ids[0] ?? null,
      detail: {
        cluster_id: inc.cluster_id,
        proposed_name: inc.name,
        sample_count: inc.sample_count,
      },
    });
  }

  // 2. unknown_shape — saved event-type NAMES that now appear with a NEW
  //    shape hash, where the new hash carries enough volume to matter.
  const min = options.highVolumeShapeMin ?? 3;
  const savedNamesByName = new Map(
    savedSchema.event_types.map((c) => [c.name, c]),
  );
  for (const inc of incoming.event_types) {
    if (inc.sample_count < min) continue;
    if (savedClusterIds.has(inc.cluster_id)) continue;
    const sameName = savedNamesByName.get(inc.name);
    if (!sameName) continue;
    // It's already flagged as new_event_type — augment that case with the
    // observation that the name is recycled. We don't double-emit.
    const last = drifts[drifts.length - 1];
    if (last && last.category === "new_event_type" && last.detail.cluster_id === inc.cluster_id) {
      last.detail.is_known_event_type_with_new_shape = true;
      last.detail.previous_cluster_id = sameName.cluster_id;
      // Re-tag as unknown_shape — more specific.
      last.category = "unknown_shape";
    }
  }

  // 3. missing_field — paths required in saved schema, but absent (or
  //    presence=0) in incoming.
  for (const [path, spec] of Object.entries(savedSchema.fields)) {
    if (path === "$") continue;
    if (!spec.required) continue;
    const incSpec = incoming.fields[path];
    if (!incSpec || incSpec.presence === 0) {
      drifts.push({
        category: "missing_field",
        field_path: path,
        sample_event_id: recent[0]!.event_id,
        detail: {
          previously: { types: spec.types, presence: spec.presence },
          now: { observed: incSpec?.presence ?? 0 },
        },
      });
    }
  }

  // 4. type_change — same path, different primitive type set.
  for (const [path, spec] of Object.entries(savedSchema.fields)) {
    if (path === "$") continue;
    const incSpec = incoming.fields[path];
    if (!incSpec) continue;
    if (!sameTypeSet(spec.types, incSpec.types)) {
      drifts.push({
        category: "type_change",
        field_path: path,
        sample_event_id: recent[0]!.event_id,
        detail: {
          previously: spec.types,
          now: incSpec.types,
        },
      });
    }
  }

  // 5. new_sensitive_field — paths in incoming.sensitive_fields not in saved.
  const savedSensitive = new Set(
    savedSchema.sensitive_fields.map((s) => s.path),
  );
  for (const s of incoming.sensitive_fields) {
    if (savedSensitive.has(s.path)) continue;
    drifts.push({
      category: "new_sensitive_field",
      field_path: s.path,
      sample_event_id: recent[0]!.event_id,
      detail: { reason: s.reason },
    });
  }

  return drifts;
}

function sameTypeSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const asort = [...a].sort();
  const bsort = [...b].sort();
  for (let i = 0; i < asort.length; i++) {
    if (asort[i] !== bsort[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Runner — wires detectDrift into the sampler + repository.
// ---------------------------------------------------------------------------

export interface RunDriftDeps {
  sampler?: typeof sampleSourceEvents;
  inserter?: typeof insertDriftEvent;
  lister?: typeof listUnresolvedDriftEvents;
  /** CH distinct-type-name lister for the long-tail coverage check. */
  typeLister?: typeof listDistinctEventTypes;
}

export interface RunDriftInput {
  map: DataContractRow;
  currentVersion: DataContractVersionRow;
}

/**
 * Detect drift for a single Data Contract. Caller (the cron handler) iterates
 * active maps and calls this per map. Returns the number of new drift
 * records inserted — used by the periodic job to drive a notifications
 * fan-out in AXE-48.
 */
export async function runDriftForDataContract(
  workspaceId: string,
  input: RunDriftInput,
  deps: RunDriftDeps = {},
  client?: Queryable,
): Promise<{ inserted: number; drifts: DetectedDrift[] }> {
  const sampler = deps.sampler ?? sampleSourceEvents;
  const inserter = deps.inserter ?? insertDriftEvent;
  const lister = deps.lister ?? listUnresolvedDriftEvents;
  const typeLister = deps.typeLister ?? listDistinctEventTypes;
  const savedSchema = input.currentVersion.inferred_schema as InferredDataContract;

  // Use a small, recent window — drift detection runs frequently so we
  // don't need 200 events each pass. `maxDays: 7` keeps candidates inside
  // the R2 raw-payload safety floor (payloads are swept as early as ~7 days
  // even though ClickHouse metadata lives 30), so we don't sample events
  // whose payloads have already aged out of R2 — the cause of the spurious
  // "Couldn't read any payloads from R2" errors. Recent traffic is also all
  // drift detection needs.
  const samples = await sampler(workspaceId, input.map.source_id, {
    maxEvents: 50,
    maxBytes: 1 * 1024 * 1024,
    maxDays: 7,
    perDayBudgetToday: 30,
  });

  const drifts = detectDrift(savedSchema, samples);

  // Long-tail type coverage. The proportional payload sample above is dominated
  // by high-volume types, so a rare event type missed at inference (or one that
  // only appears occasionally) would never surface as `new_event_type` and thus
  // never trigger auto-extend. A cheap CH distinct-type-name aggregate (no R2
  // fetches) catches those: any typed name the stream has emitted that the saved
  // schema lacks is a new type. One summary drift is enough — it's deduped to a
  // single `new_event_type|` key, and auto-extend re-samples the full set.
  try {
    const streamTypes = await typeLister(workspaceId, input.map.source_id, { maxDays: 30 });
    if (streamTypes.length > 0) {
      const savedNames = new Set(savedSchema.event_types.map((c) => c.name));
      const missing = streamTypes.filter((t) => !savedNames.has(t));
      const alreadyFlagged = drifts.some((d) => d.category === "new_event_type");
      if (missing.length > 0 && !alreadyFlagged) {
        drifts.push({
          category: "new_event_type",
          field_path: null,
          sample_event_id: null,
          detail: {
            via: "event_type_index",
            missing_event_types: missing.slice(0, 50),
            missing_count: missing.length,
          },
        });
      }
    }
  } catch {
    /* CH blip / pre-migration column — fall back to shape-based detection only */
  }

  if (drifts.length === 0) return { inserted: 0, drifts: [] };

  // Dedup against the existing unresolved drift events for this map so we
  // don't write the same row every run. Two drifts are considered "same"
  // if their (category, field_path) match.
  const existing = await lister(workspaceId, input.map.id, client);
  const existingKeys = new Set(
    existing.map((d) => `${d.category}|${d.field_path ?? ""}`),
  );

  let inserted = 0;
  const persisted: DetectedDrift[] = [];
  for (const drift of drifts) {
    const key = `${drift.category}|${drift.field_path ?? ""}`;
    if (existingKeys.has(key)) continue;
    const row: InsertDriftInput = {
      dataContractId: input.map.id,
      dataContractVersionId: input.currentVersion.id,
      workspaceId,
      category: drift.category,
      fieldPath: drift.field_path ?? null,
      sampleEventId: drift.sample_event_id ?? null,
      detail: drift.detail,
    };
    await inserter(row, client);
    inserted += 1;
    persisted.push(drift);
  }
  return { inserted, drifts: persisted };
}

// ---------------------------------------------------------------------------
// Auto-extension Phase 2: when drift fires new_event_type, append a new
// draft version with the additional cluster so the operator's response
// is "review & promote" not "re-sample & rebuild".
// ---------------------------------------------------------------------------

export interface AutoExtendResult {
  /** True when a new version was appended. False = no-op (no new clusters). */
  extended: boolean;
  new_version_id: string | null;
  added_clusters: string[];
}

export interface AutoExtendDeps {
  sampler?: typeof sampleSourceEvents;
  versionAppender?: typeof appendDataContractVersion;
  notifier?: typeof emitNotification;
}

/**
 * If the most recent drift run found at least one `new_event_type`,
 * re-sample + re-infer, and if the inferred schema contains a cluster
 * the current version doesn't, append a new version that incorporates
 * it. Notification kind: `data_contract_auto_extended`.
 *
 * Idempotency: if the "new" cluster is already present in the current
 * version (a previous run already auto-extended), this is a no-op.
 */
export async function autoExtendIfNeeded(
  map: DataContractRow,
  currentVersion: DataContractVersionRow,
  drifts: DetectedDrift[],
  deps: AutoExtendDeps = {},
): Promise<AutoExtendResult> {
  const hasNewType = drifts.some((d) => d.category === "new_event_type");
  if (!hasNewType) {
    return { extended: false, new_version_id: null, added_clusters: [] };
  }
  const sampler = deps.sampler ?? sampleSourceEventsPreferIndex;
  const versionAppender = deps.versionAppender ?? appendDataContractVersion;
  const notifier = deps.notifier ?? emitNotification;

  let samples: SampledEvent[];
  try {
    // Drift DETECTION runs on a cheap 50-event window, but once it's decided
    // to extend we re-sample exhaustively (default: event-type index, falling
    // back to a wide 200-event random pull) so a single extension lands the
    // full long tail of event types rather than dribbling them in one cron
    // pass at a time. Matches the manual "Refresh now" path.
    samples = await sampler(map.workspace_id, map.source_id, {
      maxEvents: 200,
    });
  } catch {
    return { extended: false, new_version_id: null, added_clusters: [] };
  }
  if (samples.length === 0) {
    return { extended: false, new_version_id: null, added_clusters: [] };
  }

  const next = inferDeterministic(samples);
  const currentSchema = currentVersion.inferred_schema as InferredDataContract;
  const knownClusterIds = new Set(
    (currentSchema.event_types ?? []).map((c) => c.cluster_id),
  );
  // Backward-compat for pre-2026-05-18 schemas: cluster ids used to be
  // raw shape hashes. Match incoming clusters by sample shape hash too
  // so idempotency holds across the format change — without this, a
  // map whose saved cluster_id is the old raw hash would re-extend on
  // every cron pass forever.
  const RAW_HASH_RE = /^[0-9a-f]{8}$/;
  const knownRawHashes = new Set(
    (currentSchema.event_types ?? [])
      .map((c) => c.cluster_id)
      .filter((id) => RAW_HASH_RE.test(id)),
  );
  const shapesByCluster = new Map<string, Set<string>>();
  for (const s of samples) {
    const id = clusterIdFor(s);
    let set = shapesByCluster.get(id);
    if (!set) {
      set = new Set<string>();
      shapesByCluster.set(id, set);
    }
    set.add(s.shape_hash);
  }
  const addedClusters = next.event_types
    .filter((c) => {
      if (knownClusterIds.has(c.cluster_id)) return false;
      const shapes = shapesByCluster.get(c.cluster_id);
      if (shapes && shapes.size > 0 && knownRawHashes.size > 0) {
        let allKnown = true;
        for (const h of shapes) {
          if (!knownRawHashes.has(h)) {
            allKnown = false;
            break;
          }
        }
        if (allKnown) return false;
      }
      return true;
    })
    .map((c) => c.name);
  if (addedClusters.length === 0) {
    // The "new" drift didn't actually expand the cluster set in this
    // resample — could be transient, or already extended by a previous
    // cron tick. No-op.
    return { extended: false, new_version_id: null, added_clusters: [] };
  }

  // Append a new version carrying the broader schema. Field annotations,
  // generated artifacts, destination mapping are carried forward so a
  // routing pipeline doesn't get blown up by the extension.
  const newVersion = await versionAppender({
    dataContractId: map.id,
    workspaceId: map.workspace_id,
    inferredSchema: next,
    fieldAnnotations: currentVersion.field_annotations,
    generatedFilter: currentVersion.generated_filter,
    generatedTransform: currentVersion.generated_transform,
    transformLanguage: currentVersion.transform_language,
    destinationMapping: currentVersion.destination_mapping,
    modelMetadata: {
      ...(currentVersion.model_metadata as Record<string, unknown>),
      auto_extended_at: new Date().toISOString(),
      auto_extended_from_version_id: currentVersion.id,
      added_clusters: addedClusters,
    },
    createdByUserId: null,
  });

  try {
    await notifier({
      workspaceId: map.workspace_id,
      userId: null,
      kind: "data_contract_auto_extended",
      severity: "info",
      title: `New event type${addedClusters.length === 1 ? "" : "s"} added to ${map.name}`,
      bodyMd: `Axel auto-extended the Data Contract to include: ${addedClusters
        .map((c) => `\`${c}\``)
        .join(", ")}. Drift watching continues against this expanded schema.`,
      linkPath: `/data-contracts/${map.id}`,
      dedupKey: `data_contract_auto_extended:${newVersion.id}`,
      metadata: {
        data_contract_id: map.id,
        new_version_id: newVersion.id,
        added_clusters: addedClusters,
      },
    });
  } catch {
    /* notification soft-fail; the version is committed */
  }

  return {
    extended: true,
    new_version_id: newVersion.id,
    added_clusters: addedClusters,
  };
}

// ---------------------------------------------------------------------------
// Cron orchestrator — wires the detector to notifications across every
// active Data Contract in every workspace.
// ---------------------------------------------------------------------------

export interface DriftCronSummary {
  total_maps: number;
  scanned_maps: number;
  /** Maps that produced at least one new drift row. */
  maps_with_drift: number;
  total_drift_inserted: number;
  total_notifications_emitted: number;
  /** Maps that were auto-extended (new_event_type fed back into a new version). */
  maps_auto_extended: number;
  /** Per-map errors so a failure on one workspace doesn't hide the rest. */
  errors: Array<{ data_contract_id: string; workspace_id: string; message: string }>;
  duration_ms: number;
}

export interface DriftCronDeps {
  /** Lister for watched maps (defaults to repository.listAllDriftWatchedDataContracts). */
  listMaps?: typeof listAllDriftWatchedDataContracts;
  /** Version getter to resolve current_version_id → row. */
  versionGetter?: typeof getDataContractVersion;
  /** Per-map runner — same signature as runDriftForDataContract. */
  runOne?: typeof runDriftForDataContract;
  /** Drift → notifications fan-out. */
  notify?: typeof notifyOnDrift;
  /** Auto-extension hook. */
  autoExtend?: typeof autoExtendIfNeeded;
  /** Disable auto-extension for this run. Default: enabled. */
  autoExtendDisabled?: boolean;
  /** Optional cap on number of maps scanned per run. Defaults to unbounded
   *  beyond the repository's 2000-row LIMIT. */
  maxMaps?: number;
}

/**
 * Iterate every drift-watched Data Contract (active + draft), run the drift
 * detector, fan results into the notifications surface. Designed to be
 * invoked by a Vercel cron (see app/api/cron/data-contracts-drift/route.ts).
 *
 * Robustness goals:
 *   - One map's failure doesn't abort the loop. Errors are collected
 *     into the summary and surfaced to ops via Sentry by the caller.
 *   - Notification emission is best-effort; if it throws we record the
 *     error but don't roll back the drift insert (those are independent
 *     persistence acts and the next run will dedup the drift row anyway).
 */
export async function runDriftCronJob(
  deps: DriftCronDeps = {},
): Promise<DriftCronSummary> {
  const started = Date.now();
  const listMaps = deps.listMaps ?? listAllDriftWatchedDataContracts;
  const versionGetter = deps.versionGetter ?? getDataContractVersion;
  const runOne = deps.runOne ?? runDriftForDataContract;
  const notify = deps.notify ?? notifyOnDrift;
  const autoExtend = deps.autoExtend ?? autoExtendIfNeeded;

  const maps = await listMaps();
  const limited =
    deps.maxMaps !== undefined ? maps.slice(0, deps.maxMaps) : maps;

  const summary: DriftCronSummary = {
    total_maps: maps.length,
    scanned_maps: 0,
    maps_with_drift: 0,
    total_drift_inserted: 0,
    total_notifications_emitted: 0,
    maps_auto_extended: 0,
    errors: [],
    duration_ms: 0,
  };

  for (const map of limited) {
    summary.scanned_maps += 1;
    try {
      if (!map.current_version_id) continue;
      const version = await versionGetter(map.current_version_id, map.workspace_id);
      if (!version) continue;
      const { inserted, drifts } = await runOne(map.workspace_id, {
        map,
        currentVersion: version,
      });
      summary.total_drift_inserted += inserted;
      if (inserted > 0) {
        summary.maps_with_drift += 1;
        try {
          const emitted = await notify(
            map.workspace_id,
            map.id,
            drifts.map((d) => ({
              category: d.category,
              field_path: d.field_path,
            })),
          );
          summary.total_notifications_emitted += emitted;
        } catch (err) {
          summary.errors.push({
            data_contract_id: map.id,
            workspace_id: map.workspace_id,
            message: `notify: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        if (!deps.autoExtendDisabled) {
          try {
            const result = await autoExtend(map, version, drifts);
            if (result.extended) summary.maps_auto_extended += 1;
          } catch (err) {
            summary.errors.push({
              data_contract_id: map.id,
              workspace_id: map.workspace_id,
              message: `auto_extend: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    } catch (err) {
      summary.errors.push({
        data_contract_id: map.id,
        workspace_id: map.workspace_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  summary.duration_ms = Date.now() - started;
  return summary;
}

// Re-export for caller convenience — keeps drift-detection callers from
// reaching across modules for the FieldSpec type they need.
export type { FieldSpec };
