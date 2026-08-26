/**
 * Parquet compaction orchestration.
 *
 * One tick: for each Parquet route, list its objects, ask the pure planner
 * (`planCompaction`) what to merge, then for each merge job read + merge +
 * write the combined object and — only after re-confirming the merged object
 * exists — delete the originals from the customer bucket.
 *
 * All S3 I/O goes through the injected `CompactionS3Access` so the
 * merge→verify→delete cycle is unit-testable against real Parquet buffers
 * without the network. The delete is deliberately gated behind a verified PUT:
 * we never remove an original until its merged replacement is confirmed
 * present.
 *
 * Durable job identity: every merge writes a manifest sidecar (the exact
 * input-key set) BEFORE the merged object, and reconciliation runs before
 * planning on every tick. Job membership is derived from a live listing, so
 * without the manifest a merge whose source delete failed would be re-planned
 * over a CHANGED candidate set (e.g. a new straggler aged in) — a different
 * input set hashes to a different compacted key, and the second merge would
 * re-include the already-merged originals, permanently duplicating rows.
 */
import { createHash } from "node:crypto";
import { mergeParquetBuffers } from "./connectors/parquet-format.js";
import { partitionOf, planCompaction, type StagedParquetObject } from "./parquet-compaction.js";

export interface CompactionS3Object {
  key: string;
  sizeBytes: number;
  lastModifiedMs: number;
}

/** The minimal S3 surface compaction needs. The real implementation wraps an
 *  AWS `S3Client`; tests pass an in-memory fake. */
export interface CompactionS3Access {
  list(bucket: string, prefix: string): Promise<CompactionS3Object[]>;
  get(bucket: string, key: string): Promise<Buffer>;
  put(bucket: string, key: string, body: Buffer, metadata: Record<string, string>): Promise<void>;
  /** HEAD — true if the object exists. Used to verify a merge landed before
   *  deleting its sources. */
  exists(bucket: string, key: string): Promise<boolean>;
  remove(bucket: string, keys: string[]): Promise<void>;
}

export interface CompactionTarget {
  workspaceId: string;
  destinationId: string;
  routeId: string;
  bucket: string;
  /** Listing prefix (the route's key_prefix). */
  prefix: string;
  /** Desired merged-object size for this route. */
  targetBytes: number;
}

export interface CompactionTickOptions {
  smallFileBytes: number;
  minFilesToMerge: number;
  safetyWindowMs: number;
  maxInputsPerJob: number;
  nowMs: number;
}

export interface CompactionResult {
  routeId: string;
  destinationId: string;
  /** Merge jobs the planner produced. */
  jobs: number;
  /** Merged objects successfully written + verified. */
  merged: number;
  /** Original objects deleted. */
  deleted: number;
  /** Subset of `deleted` removed by reconciliation — originals a prior tick
   *  merged into a verified compacted object but then failed to delete. */
  reconciled: number;
  /** Rows carried through merges. */
  rows: number;
  errors: string[];
}

/** Run compaction for a single Parquet route. Never throws — per-job failures
 *  are collected so one bad object can't abort the route or the loop. */
export async function runCompactionForTarget(
  target: CompactionTarget,
  s3: CompactionS3Access,
  opts: CompactionTickOptions,
): Promise<CompactionResult> {
  const result: CompactionResult = {
    routeId: target.routeId,
    destinationId: target.destinationId,
    jobs: 0,
    merged: 0,
    deleted: 0,
    reconciled: 0,
    rows: 0,
    errors: [],
  };

  let listed: CompactionS3Object[];
  try {
    listed = await s3.list(target.bucket, target.prefix);
  } catch (err) {
    result.errors.push(`list_failed: ${errMsg(err)}`);
    return result;
  }

  // Reconcile prior incomplete jobs BEFORE planning anything new: a manifest
  // whose compacted object exists but whose inputs are still listed marks a
  // failed source delete. Finish that delete (and exclude those inputs from
  // planning) first — re-planning over a changed candidate set would hash to a
  // DIFFERENT compacted key and duplicate the already-merged rows.
  const { consumedKeys, blockedPartitions } = await reconcilePriorJobs(target, s3, listed, result);

  const objects: StagedParquetObject[] = listed
    .filter(
      (o) =>
        o.key.endsWith(".parquet") &&
        !isCompactedKey(o.key) &&
        !consumedKeys.has(o.key) &&
        !blockedPartitions.has(partitionOf(o.key)),
    )
    .map((o) => ({ key: o.key, sizeBytes: o.sizeBytes, lastModifiedMs: o.lastModifiedMs }));

  const jobs = planCompaction(objects, {
    // Clamp so a freshly-merged file is never itself a "small" candidate
    // (>= smallFileBytes) and a single job's decode budget stays memory-safe
    // (<= MAX_COMPACTION_JOB_BYTES) regardless of a route's parquet_target_bytes.
    targetBytes: Math.min(Math.max(target.targetBytes, opts.smallFileBytes), MAX_COMPACTION_JOB_BYTES),
    smallFileBytes: opts.smallFileBytes,
    minFilesToMerge: opts.minFilesToMerge,
    safetyWindowMs: opts.safetyWindowMs,
    maxInputsPerJob: opts.maxInputsPerJob,
    nowMs: opts.nowMs,
  });
  result.jobs = jobs.length;

  for (const job of jobs) {
    try {
      // Bound the get() concurrency. The delivery-service shares a 512MB Render
      // starter plan with other loops, and a single job can fan out to
      // maxInputsPerJob keys — loading them all at once (the old Promise.all)
      // peaks at the sum of every input buffer. With a small ceiling, peak
      // resident memory is ~targetBytes + a handful of in-flight input buffers.
      const buffers = await boundedMap(job.inputKeys, GET_CONCURRENCY, (k) =>
        s3.get(target.bucket, k),
      );
      const { buffer, rowCount } = await mergeParquetBuffers(buffers, {
        batchId: mergedId(job.inputKeys),
        workspaceId: target.workspaceId,
        routeId: target.routeId,
        destinationId: target.destinationId,
      });
      const outKey = mergedKey(job.partition, job.inputKeys);
      const manifest = manifestKeyFor(outKey);

      // Durable job identity: record the exact input set BEFORE the merged
      // object can exist. A manifest without its object is harmless (next
      // tick's reconciliation drops it); a merged object without a manifest
      // could let a re-plan over a changed candidate set duplicate its rows.
      await s3.put(
        target.bucket,
        manifest,
        Buffer.from(JSON.stringify({ inputKeys: job.inputKeys } satisfies CompactionManifest)),
        { format: "compaction-manifest", source_files: String(job.inputKeys.length) },
      );

      await s3.put(target.bucket, outKey, buffer, {
        format: "parquet",
        compacted: "true",
        row_count: String(rowCount),
        source_files: String(job.inputKeys.length),
      });

      // Verified-PUT gate: do not delete sources unless the merged object is
      // confirmed present.
      if (!(await s3.exists(target.bucket, outKey))) {
        result.errors.push(`verify_failed: ${outKey}`);
        continue;
      }

      // The merge has fully landed (written + verified). Count it now, BEFORE
      // attempting the source delete — a delete failure here doesn't undo the
      // merge, and we must not lose the merged/rows tally just because cleanup
      // of the originals failed (they're harmless duplicates a retry resolves).
      result.merged += 1;
      result.rows += rowCount;

      // Guard against ever deleting the object we just wrote (the merged key is
      // content-hashed so it can't equal an input, but be defensive).
      const toDelete = job.inputKeys.filter((k) => k !== outKey);
      try {
        await s3.remove(target.bucket, toDelete);
        result.deleted += toDelete.length;
        // Job fully complete — the manifest has served its purpose. A failure
        // here is harmless: reconciliation drops a manifest whose inputs are
        // all gone on the next tick.
        await s3.remove(target.bucket, [manifest]).catch(() => {});
      } catch (err) {
        // Record the cleanup failure distinctly so it's visible, but keep the
        // merged count above. Don't over-count result.deleted — the originals
        // are still present and a later tick will retry the (idempotent) delete.
        result.errors.push(`delete_failed: ${errMsg(err)}`);
      }
    } catch (err) {
      result.errors.push(`merge_failed: ${errMsg(err)}`);
    }
  }

  return result;
}

/** Concurrency ceiling on per-job input gets — see the call site for the
 *  512MB-plan rationale. Small enough that peak memory stays bounded. */
const GET_CONCURRENCY = 4;

/** Estimated decoded-to-compressed expansion during a merge. mergeParquetBuffers
 *  decodes every input into JS row objects before re-encoding, so the memory
 *  that matters is the decompressed rows, not the on-disk bytes the planner
 *  sums. SNAPPY on JSON-ish text typically expands 2-3x on decode; 4x adds
 *  headroom for JS string/object overhead. */
const ESTIMATED_DECODE_RATIO = 4;

/** Cap a single compaction job's summed *compressed* input bytes so the decoded
 *  rows held during the merge (~ESTIMATED_DECODE_RATIO × this) stay near 128MB
 *  on the shared 512MB worker — even with the planner's one-file overshoot past
 *  targetBytes — regardless of a route's parquet_target_bytes. */
const MAX_COMPACTION_JOB_BYTES = (128 * 1024 * 1024) / ESTIMATED_DECODE_RATIO;

/** True for objects this module itself produced (mergedKey writes
 *  `${partition}compacted-<hash>.parquet`). Compacted outputs must NEVER be
 *  re-selected as merge candidates: one that lands below smallFileBytes would
 *  otherwise be merged again WITH its still-present sources after a failed
 *  delete, permanently doubling rows. */
function isCompactedKey(key: string): boolean {
  return key.slice(key.lastIndexOf("/") + 1).startsWith("compacted-");
}

/** Durable record of a merge job's exact input set, written as a sidecar next
 *  to the compacted object (see manifestKeyFor). Lets a later tick distinguish
 *  "these originals were already merged but their delete failed" from "these
 *  are fresh candidates" even after the partition's candidate set changes. */
interface CompactionManifest {
  inputKeys: string[];
}

/** Sidecar manifest key for a merged object — same partition + hash, with a
 *  `.manifest.json` suffix so the `.parquet` candidate filter never selects it. */
export function manifestKeyFor(mergedObjectKey: string): string {
  return `${mergedObjectKey.slice(0, -".parquet".length)}.manifest.json`;
}

function isManifestKey(key: string): boolean {
  return isCompactedKey(key) && key.endsWith(".manifest.json");
}

function compactedKeyForManifest(manifestKey: string): string {
  return `${manifestKey.slice(0, -".manifest.json".length)}.parquet`;
}

function parseManifest(body: Buffer): CompactionManifest {
  const parsed = JSON.parse(body.toString("utf8")) as { inputKeys?: unknown };
  if (
    !Array.isArray(parsed.inputKeys) ||
    !parsed.inputKeys.every((k): k is string => typeof k === "string")
  ) {
    throw new Error("malformed manifest");
  }
  return { inputKeys: parsed.inputKeys };
}

/**
 * Finish (or neutralize) prior merge jobs whose source delete never landed.
 *
 * For every manifest sidecar in the listing:
 *   - compacted object present + manifest inputs still listed → the prior
 *     tick's delete failed. Re-delete the inputs (finishing the old job) and
 *     exclude them from this tick's planning so a changed candidate set can
 *     never re-merge already-compacted rows under a new key.
 *   - compacted object present + no inputs left → the job fully completed;
 *     drop the now-redundant manifest.
 *   - compacted object absent → the job never landed (crash before the PUT,
 *     or verify failure). The inputs were never replaced, so leave them as
 *     candidates and drop the stale manifest.
 *
 * If a manifest can't be read or its inputs can't be deleted, the whole
 * partition is blocked for this tick — planning there without knowing what a
 * prior job consumed risks exactly the duplication this exists to prevent.
 */
async function reconcilePriorJobs(
  target: CompactionTarget,
  s3: CompactionS3Access,
  listed: CompactionS3Object[],
  result: CompactionResult,
): Promise<{ consumedKeys: Set<string>; blockedPartitions: Set<string> }> {
  const consumedKeys = new Set<string>();
  const blockedPartitions = new Set<string>();
  const listedKeys = new Set(listed.map((o) => o.key));

  for (const obj of listed) {
    if (!isManifestKey(obj.key)) continue;
    try {
      const compactedKey = compactedKeyForManifest(obj.key);
      if (!listedKeys.has(compactedKey)) {
        await s3.remove(target.bucket, [obj.key]);
        continue;
      }
      const manifest = parseManifest(await s3.get(target.bucket, obj.key));
      const stillPresent = manifest.inputKeys.filter(
        (k) => k !== compactedKey && listedKeys.has(k),
      );
      for (const k of stillPresent) consumedKeys.add(k);
      if (stillPresent.length > 0) {
        await s3.remove(target.bucket, stillPresent);
        result.deleted += stillPresent.length;
        result.reconciled += stillPresent.length;
      }
      await s3.remove(target.bucket, [obj.key]);
    } catch (err) {
      // consumedKeys already holds anything identified before the failure, and
      // the blocked partition suppresses all planning there, so a half-failed
      // reconcile can never be worse than doing nothing this tick.
      blockedPartitions.add(partitionOf(obj.key));
      result.errors.push(`reconcile_failed: ${obj.key}: ${errMsg(err)}`);
    }
  }

  return { consumedKeys, blockedPartitions };
}

/** Run `fn` over `items` with at most `limit` in flight at once, preserving
 *  input order in the result. Tiny inline helper so compaction has no new
 *  dependency. */
async function boundedMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const ceiling = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: ceiling }, worker));
  return out;
}

/** Deterministic merged-object key: stable for a given input set so a retry
 *  after a partial failure overwrites the same object rather than littering
 *  the bucket. Lives in the inputs' shared partition. */
export function mergedKey(partition: string, inputKeys: string[]): string {
  return `${partition}compacted-${hashKeys(inputKeys)}.parquet`;
}

function mergedId(inputKeys: string[]): string {
  return `compacted_${hashKeys(inputKeys)}`;
}

function hashKeys(inputKeys: string[]): string {
  const h = createHash("sha1");
  h.update([...inputKeys].sort().join("\n"));
  return h.digest("hex").slice(0, 16);
}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
