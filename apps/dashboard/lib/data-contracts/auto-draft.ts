import "server-only";
import { inferDataContract } from "./inference";
import {
  appendDataContractVersion,
  createDataContract,
  listSourcesWithoutDataContract,
  type DataContractRow,
  type DataContractVersionRow,
  type SourceWithoutDataContractRow,
} from "./repository";
import { sampleSourceEvents, type SampledEvent } from "./sampler";
import { emitNotification } from "../notifications";

/**
 * Auto-draft Data Contracts for sources that don't have one yet.
 *
 * Triggered from a Vercel cron every ~30 min (see
 * apps/dashboard/app/api/cron/data-contracts-auto-draft/route.ts). The idea
 * is that the moment a customer points a source at Axel and a few
 * events arrive, a draft contract should already be waiting in the
 * dashboard — they shouldn't have to discover "Understand source" to
 * see what they emit.
 *
 * Conservative defaults:
 *   - Require at least MIN_SAMPLES to commit a draft. With 1–2 samples
 *     the inferred schema is too thin to be useful, and we'd rather try
 *     again on the next cron tick after more events arrive.
 *   - Skip the LLM enrichment pass (faster + cheaper for the batch
 *     path; the user can re-run "Understand source" to get the
 *     LLM-enriched names + summary). Deterministic inference is still
 *     authoritative for fields/ids/timestamps/PII either way.
 *   - Mark the created map with `auto: true` in model_metadata so the
 *     UI can later say "Axel drafted this for you" if we want a hint.
 */
const MIN_SAMPLES = 3;

export type AutoDraftOutcome =
  | { kind: "drafted"; data_contract_id: string; sample_count: number }
  | { kind: "skipped"; reason: "no_samples" | "too_few_samples" }
  | { kind: "errored"; message: string };

export interface AutoDraftDeps {
  sampler?: typeof sampleSourceEvents;
  inferer?: typeof inferDataContract;
  creator?: typeof createDataContract;
  versionAppender?: typeof appendDataContractVersion;
  notifier?: typeof emitNotification;
  /** Reference clock for the default map name suffix. */
  now?: () => Date;
}

function defaultMapName(sourceName: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return `${sourceName.slice(0, 60)} — ${stamp}`;
}

export async function autoDraftDataContract(
  source: SourceWithoutDataContractRow,
  deps: AutoDraftDeps = {},
): Promise<AutoDraftOutcome> {
  const sampler = deps.sampler ?? sampleSourceEvents;
  const inferer = deps.inferer ?? inferDataContract;
  const creator = deps.creator ?? createDataContract;
  const versionAppender = deps.versionAppender ?? appendDataContractVersion;
  const notifier = deps.notifier ?? emitNotification;
  const now = deps.now ?? (() => new Date());

  let samples: SampledEvent[];
  try {
    samples = await sampler(source.workspace_id, source.source_id, {
      maxEvents: 50,
      maxBytes: 1 * 1024 * 1024,
    });
  } catch (err) {
    return {
      kind: "errored",
      message: `sampler: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (samples.length === 0) {
    return { kind: "skipped", reason: "no_samples" };
  }
  if (samples.length < MIN_SAMPLES) {
    return { kind: "skipped", reason: "too_few_samples" };
  }

  let inferred: Awaited<ReturnType<typeof inferDataContract>>;
  try {
    inferred = await inferer(samples, { llmDisabled: true });
  } catch (err) {
    return {
      kind: "errored",
      message: `infer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let map: DataContractRow;
  try {
    map = await creator({
      workspaceId: source.workspace_id,
      sourceId: source.source_id,
      name: defaultMapName(source.name, now()),
      createdByUserId: null,
    });
  } catch (err) {
    // Most likely a unique-name 23505 collision if the operator named
    // a different map similarly. Skip rather than retry — the next
    // tick will see the existing map and not re-create.
    return {
      kind: "errored",
      message: `create: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let version: DataContractVersionRow;
  try {
    version = await versionAppender({
      dataContractId: map.id,
      workspaceId: source.workspace_id,
      inferredSchema: inferred,
      modelMetadata: { ...inferred.model_metadata, auto: true },
      createdByUserId: null,
    });
  } catch (err) {
    return {
      kind: "errored",
      message: `append: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Best-effort notification. If this fails the draft still exists in
  // the dashboard — the user will discover it when they next look at
  // the source. We don't want a Resend hiccup to roll the whole
  // operation back.
  try {
    await notifier({
      workspaceId: source.workspace_id,
      userId: null, // workspace-wide
      kind: "data_contract_auto_drafted",
      severity: "info",
      title: `Schema detected for ${source.name}`,
      bodyMd: `Axel built a draft Data Contract from ${samples.length} sampled events. Review and activate to enable drift watching.`,
      linkPath: `/data-contracts/${map.id}`,
      // dedup_key includes the new data_contract_id, so this can never
      // collide with a previous auto-draft (different sources / re-
      // creates after deletion).
      dedupKey: `data_contract_auto_drafted:${map.id}`,
      metadata: {
        source_id: source.source_id,
        data_contract_id: map.id,
        data_contract_version_id: version.id,
        sample_count: samples.length,
      },
    });
  } catch {
    // swallow — draft is already persisted
  }

  return {
    kind: "drafted",
    data_contract_id: map.id,
    sample_count: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Cron orchestrator
// ---------------------------------------------------------------------------

export interface AutoDraftCronSummary {
  total_candidates: number;
  scanned: number;
  drafted: number;
  skipped_no_samples: number;
  skipped_too_few: number;
  errors: Array<{ source_id: string; workspace_id: string; message: string }>;
  duration_ms: number;
}

export interface AutoDraftCronDeps extends AutoDraftDeps {
  listSources?: typeof listSourcesWithoutDataContract;
  /** Cap per run so the cron can't run unbounded. */
  maxSources?: number;
}

/**
 * Walk sources that don't yet have a Data Contract and try to draft one.
 * Like the drift cron, per-source failures are isolated.
 */
export async function runAutoDraftCronJob(
  deps: AutoDraftCronDeps = {},
): Promise<AutoDraftCronSummary> {
  const started = Date.now();
  const listSources = deps.listSources ?? listSourcesWithoutDataContract;
  const candidates = await listSources();
  const limited =
    deps.maxSources !== undefined
      ? candidates.slice(0, deps.maxSources)
      : candidates;

  const summary: AutoDraftCronSummary = {
    total_candidates: candidates.length,
    scanned: 0,
    drafted: 0,
    skipped_no_samples: 0,
    skipped_too_few: 0,
    errors: [],
    duration_ms: 0,
  };

  for (const source of limited) {
    summary.scanned += 1;
    const outcome = await autoDraftDataContract(source, deps);
    if (outcome.kind === "drafted") {
      summary.drafted += 1;
    } else if (outcome.kind === "skipped") {
      if (outcome.reason === "no_samples") summary.skipped_no_samples += 1;
      else summary.skipped_too_few += 1;
    } else {
      summary.errors.push({
        source_id: source.source_id,
        workspace_id: source.workspace_id,
        message: outcome.message,
      });
    }
  }

  summary.duration_ms = Date.now() - started;
  return summary;
}
