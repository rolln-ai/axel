/**
 * Parquet compaction planner.
 *
 * The delivery path writes one Parquet object per flushed batch. With
 * single-instance batching that's already few/large files, but stragglers
 * still appear: low-volume routes that flush on the time backstop, and
 * partial files left by a hard crash mid-batch. This module decides which
 * of those small objects to merge — it is the safety net that turns "mostly
 * large files" into "uniformly large files".
 *
 * This file is intentionally PURE: it takes a listing of objects and returns
 * a set of merge jobs. The actual S3 list/get/merge/put/delete I/O lives in
 * the worker loop that consumes these jobs, so the (high-stakes, destructive)
 * decision of *what to delete from a customer bucket* is fully unit-testable
 * here without touching the network.
 */

export interface StagedParquetObject {
  /** Full S3 key, e.g. "lake/2026-06-18/part-batch_abc.parquet". */
  key: string;
  sizeBytes: number;
  /** Object LastModified, epoch millis. */
  lastModifiedMs: number;
}

export interface CompactionPlanOptions {
  /** Desired size of a merged object. A job stops accumulating once it
   *  reaches this many (on-disk) bytes. */
  targetBytes: number;
  /** Objects at/above this size are considered "already large" and are
   *  never rewritten — only smaller files are candidates for merging. Keep
   *  this below `targetBytes` so freshly-merged files aren't re-merged. */
  smallFileBytes: number;
  /** A partition must contribute at least this many candidate files before
   *  we bother merging (merging a single file is pointless churn). */
  minFilesToMerge: number;
  /** Skip objects modified within this window — they may still be actively
   *  written/flushed, and merging then deleting one mid-write loses data. */
  safetyWindowMs: number;
  /** Cap inputs per job so a single merge can't buffer unbounded rows. */
  maxInputsPerJob: number;
  /** Current time, epoch millis (injected for determinism/testing). */
  nowMs: number;
}

export interface CompactionJob {
  /** Key "directory" the inputs share (everything up to the last '/'). */
  partition: string;
  /** Objects to read + merge, in deterministic order. */
  inputKeys: string[];
  /** Sum of input sizes — the approximate merged size before re-encode. */
  totalBytes: number;
}

/** The key prefix shared by objects in the same logical partition — the
 *  substring up to and including the last '/'. Objects with no '/' share the
 *  empty (bucket-root) partition. */
export function partitionOf(key: string): string {
  const idx = key.lastIndexOf("/");
  return idx === -1 ? "" : key.slice(0, idx + 1);
}

/**
 * Decide which small objects to merge. Pure: no I/O, no clock, no randomness.
 *
 * Rules:
 *   - Files modified within `safetyWindowMs` are skipped (may be in-flight).
 *   - Files >= `smallFileBytes` are skipped (already large enough).
 *   - Remaining small files are grouped by partition, then bin-packed into
 *     jobs of up to `targetBytes` / `maxInputsPerJob`.
 *   - A job is only emitted if it merges at least `minFilesToMerge` files —
 *     a lone leftover small file is left alone rather than rewritten.
 */
export function planCompaction(
  objects: readonly StagedParquetObject[],
  opts: CompactionPlanOptions,
): CompactionJob[] {
  const cutoff = opts.nowMs - opts.safetyWindowMs;
  const candidates = objects.filter(
    (o) => o.sizeBytes < opts.smallFileBytes && o.lastModifiedMs <= cutoff,
  );

  // Group by partition.
  const byPartition = new Map<string, StagedParquetObject[]>();
  for (const obj of candidates) {
    const part = partitionOf(obj.key);
    const arr = byPartition.get(part) ?? [];
    arr.push(obj);
    byPartition.set(part, arr);
  }

  const jobs: CompactionJob[] = [];
  // Deterministic partition order.
  for (const part of [...byPartition.keys()].sort()) {
    const files = byPartition.get(part)!;
    // Oldest first — keeps merge order stable and front-loads the files most
    // likely to never grow again.
    files.sort((a, b) =>
      a.lastModifiedMs - b.lastModifiedMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

    let bucket: StagedParquetObject[] = [];
    let bytes = 0;
    const flush = () => {
      if (bucket.length >= opts.minFilesToMerge) {
        jobs.push({ partition: part, inputKeys: bucket.map((f) => f.key), totalBytes: bytes });
      }
      bucket = [];
      bytes = 0;
    };
    for (const file of files) {
      bucket.push(file);
      bytes += file.sizeBytes;
      if (bytes >= opts.targetBytes || bucket.length >= opts.maxInputsPerJob) {
        flush();
      }
    }
    // Trailing partial bucket: merge only if it still clears the minimum, so
    // we don't churn a single straggler that may yet get more siblings.
    flush();
  }

  return jobs;
}
