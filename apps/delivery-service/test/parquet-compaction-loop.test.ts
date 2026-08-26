import { describe, expect, it } from "vitest";
import { writeParquetBuffer, readParquetRows, type S3ParquetRow } from "../src/connectors/parquet-format.ts";
import {
  runCompactionForTarget,
  mergedKey,
  manifestKeyFor,
  type CompactionS3Access,
  type CompactionS3Object,
  type CompactionTarget,
  type CompactionTickOptions,
} from "../src/parquet-compaction-loop.ts";

const NOW = 1_000_000_000_000;
const OLD = NOW - 10 * 60_000; // comfortably outside the safety window

function row(id: string): S3ParquetRow {
  return {
    event_id: id,
    workspace_id: "ws-1",
    source_id: "src-1",
    route_id: "rt-1",
    destination_id: "dst-1",
    received_at: "2026-06-18T12:00:00.000Z",
    written_at: "2026-06-18T12:00:01.000Z",
    payload_json: JSON.stringify({ id }),
  };
}

const META = { batchId: "b", workspaceId: "ws-1", routeId: "rt-1", destinationId: "dst-1" };

/** In-memory S3 fake backed by a Map of key → { body, lastModifiedMs }. */
class FakeS3 implements CompactionS3Access {
  store = new Map<string, { body: Buffer; lastModifiedMs: number }>();
  removed: string[] = [];

  async seed(key: string, rows: S3ParquetRow[], lastModifiedMs: number): Promise<void> {
    this.store.set(key, { body: await writeParquetBuffer(rows, META), lastModifiedMs });
  }
  async list(_bucket: string, prefix: string): Promise<CompactionS3Object[]> {
    return [...this.store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v]) => ({ key, sizeBytes: v.body.length, lastModifiedMs: v.lastModifiedMs }));
  }
  async get(_bucket: string, key: string): Promise<Buffer> {
    const v = this.store.get(key);
    if (!v) throw new Error(`no such key ${key}`);
    return v.body;
  }
  async put(_bucket: string, key: string, body: Buffer): Promise<void> {
    this.store.set(key, { body, lastModifiedMs: NOW });
  }
  async exists(_bucket: string, key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async remove(_bucket: string, keys: string[]): Promise<void> {
    for (const k of keys) {
      this.store.delete(k);
      this.removed.push(k);
    }
  }
}

const TARGET: CompactionTarget = {
  workspaceId: "ws-1",
  destinationId: "dst-1",
  routeId: "rt-1",
  bucket: "archive",
  prefix: "lake/",
  targetBytes: 64 * 1024 * 1024,
};

const OPTS: CompactionTickOptions = {
  smallFileBytes: 16 * 1024 * 1024,
  minFilesToMerge: 2,
  safetyWindowMs: 60_000,
  maxInputsPerJob: 100,
  nowMs: NOW,
};

describe("runCompactionForTarget", () => {
  it("merges small files, writes a verified object, and deletes the originals", async () => {
    const s3 = new FakeS3();
    await s3.seed("lake/2026-06-18/part-a.parquet", [row("a1"), row("a2")], OLD);
    await s3.seed("lake/2026-06-18/part-b.parquet", [row("b1")], OLD);

    const res = await runCompactionForTarget(TARGET, s3, OPTS);

    expect(res.jobs).toBe(1);
    expect(res.merged).toBe(1);
    expect(res.deleted).toBe(2);
    expect(res.rows).toBe(3);
    expect(res.errors).toEqual([]);

    // Originals gone (and the manifest sidecar cleaned up after the completed
    // delete), one merged object present with all 3 rows.
    expect(s3.removed).toContain("lake/2026-06-18/part-a.parquet");
    expect(s3.removed).toContain("lake/2026-06-18/part-b.parquet");
    const out = mergedKey("lake/2026-06-18/", [
      "lake/2026-06-18/part-a.parquet",
      "lake/2026-06-18/part-b.parquet",
    ]);
    expect(s3.store.has(out)).toBe(true);
    expect([...s3.store.keys()].filter((k) => k.endsWith(".manifest.json"))).toEqual([]);
    const merged = await readParquetRows(s3.store.get(out)!.body);
    expect(merged.map((r) => r.event_id).sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("leaves files inside the safety window untouched", async () => {
    const s3 = new FakeS3();
    await s3.seed("lake/d/part-a.parquet", [row("a")], NOW - 5_000); // too recent
    await s3.seed("lake/d/part-b.parquet", [row("b")], NOW - 5_000);

    const res = await runCompactionForTarget(TARGET, s3, OPTS);
    expect(res.jobs).toBe(0);
    expect(s3.removed).toEqual([]);
  });

  it("does NOT delete originals when the verify step fails", async () => {
    const s3 = new FakeS3();
    await s3.seed("lake/d/part-a.parquet", [row("a")], OLD);
    await s3.seed("lake/d/part-b.parquet", [row("b")], OLD);
    // Simulate a PUT that silently lands nothing → exists() returns false.
    s3.put = async () => {};

    const res = await runCompactionForTarget(TARGET, s3, OPTS);
    expect(res.merged).toBe(0);
    expect(res.deleted).toBe(0);
    expect(res.errors[0]).toMatch(/verify_failed/);
    expect(s3.removed).toEqual([]); // crucial: no data loss
  });

  it("finishes a failed delete via the manifest instead of re-merging", async () => {
    const s3 = new FakeS3();
    await s3.seed("lake/d/part-a.parquet", [row("a")], OLD);
    await s3.seed("lake/d/part-b.parquet", [row("b")], OLD);
    // First run: PUT works, but DELETE throws so originals survive.
    const realRemove = s3.remove.bind(s3);
    s3.remove = async () => {
      throw new Error("delete boom");
    };
    const first = await runCompactionForTarget(TARGET, s3, OPTS);
    // The delete failure is now its own classification (was misreported as
    // merge_failed before Finding 3) — and the merge itself still counts.
    expect(first.errors[0]).toMatch(/delete_failed/);
    expect(first.merged).toBe(1);

    // Restore delete; the second run's reconciliation completes the pending
    // delete recorded in the manifest — no second merge is needed.
    s3.remove = realRemove;
    const second = await runCompactionForTarget(TARGET, s3, OPTS);
    expect(second.merged).toBe(0);
    expect(second.deleted).toBe(2);
    expect(second.reconciled).toBe(2);
    // Exactly one merged object remains (manifest cleaned up too).
    const keys = [...s3.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("compacted-");
  });

  it("does not duplicate rows when a straggler ages in after a failed delete", async () => {
    // The critical divergence case: tick 1 merges [a, b] but the source delete
    // fails; a NEW straggler c then ages in before the retry. Without a durable
    // record of what the compacted object consumed, tick 2 would re-plan the
    // partition as [a, b, c] — a different input set, a different hash, a
    // SECOND compacted object re-including a and b — permanently duplicating
    // their rows.
    const s3 = new FakeS3();
    await s3.seed("lake/d/part-a.parquet", [row("a")], OLD);
    await s3.seed("lake/d/part-b.parquet", [row("b")], OLD);
    const realRemove = s3.remove.bind(s3);
    s3.remove = async () => {
      throw new Error("delete boom");
    };
    const first = await runCompactionForTarget(TARGET, s3, OPTS);
    expect(first.merged).toBe(1);
    expect(first.errors[0]).toMatch(/delete_failed/);

    // The straggler lands and ages past the safety window; deletes recover.
    await s3.seed("lake/d/part-c.parquet", [row("c")], OLD);
    s3.remove = realRemove;
    const second = await runCompactionForTarget(TARGET, s3, OPTS);

    // Reconciliation finished the original delete...
    expect(second.reconciled).toBe(2);
    expect(s3.removed).toEqual(
      expect.arrayContaining(["lake/d/part-a.parquet", "lake/d/part-b.parquet"]),
    );
    // ...and did NOT plan a second merge over [a, b, c].
    const compacted = [...s3.store.keys()].filter(
      (k) => k.includes("compacted-") && k.endsWith(".parquet"),
    );
    expect(compacted).toHaveLength(1);

    // Every row exists exactly once across the partition: a + b in the merged
    // object, c untouched (a lone straggler awaiting future siblings).
    const allRows: string[] = [];
    for (const [key, v] of s3.store) {
      if (!key.endsWith(".parquet")) continue;
      allRows.push(...(await readParquetRows(v.body)).map((r) => r.event_id));
    }
    expect(allRows.sort()).toEqual(["a", "b", "c"]);
    expect(s3.store.has("lake/d/part-c.parquet")).toBe(true);
  });

  it("blocks a partition from new merges while its prior delete keeps failing", async () => {
    // Delete-denied bucket (e.g. WORM/compliance): the first merge's cleanup
    // fails and KEEPS failing. New stragglers must not trigger further merges
    // in that partition — each one would mint another duplicate-bearing
    // compacted object.
    const s3 = new FakeS3();
    await s3.seed("lake/d/part-a.parquet", [row("a")], OLD);
    await s3.seed("lake/d/part-b.parquet", [row("b")], OLD);
    s3.remove = async () => {
      throw new Error("AccessDenied");
    };
    await runCompactionForTarget(TARGET, s3, OPTS);
    await s3.seed("lake/d/part-c.parquet", [row("c")], OLD);
    await s3.seed("lake/d/part-d.parquet", [row("d")], OLD);

    const second = await runCompactionForTarget(TARGET, s3, OPTS);

    // Reconciliation couldn't finish the old delete → the partition is skipped
    // entirely rather than merging [c, d] alongside an unresolved prior job.
    expect(second.merged).toBe(0);
    expect(second.errors.some((e) => e.startsWith("reconcile_failed"))).toBe(true);
    const compacted = [...s3.store.keys()].filter(
      (k) => k.includes("compacted-") && k.endsWith(".parquet"),
    );
    expect(compacted).toHaveLength(1);
  });

  it("drops a stale manifest whose compacted object never landed and re-merges normally", async () => {
    // Crash window: the manifest PUT succeeded but the merged-object PUT never
    // did. The inputs were never replaced, so they must stay candidates.
    const s3 = new FakeS3();
    await s3.seed("lake/d/part-a.parquet", [row("a")], OLD);
    await s3.seed("lake/d/part-b.parquet", [row("b")], OLD);
    const out = mergedKey("lake/d/", ["lake/d/part-a.parquet", "lake/d/part-b.parquet"]);
    const staleManifest = manifestKeyFor(out);
    s3.store.set(staleManifest, {
      body: Buffer.from(
        JSON.stringify({ inputKeys: ["lake/d/part-a.parquet", "lake/d/part-b.parquet"] }),
      ),
      lastModifiedMs: OLD,
    });

    const res = await runCompactionForTarget(TARGET, s3, OPTS);

    expect(s3.removed).toContain(staleManifest);
    expect(res.reconciled).toBe(0);
    expect(res.merged).toBe(1);
    expect(res.rows).toBe(2);
    const merged = await readParquetRows(s3.store.get(out)!.body);
    expect(merged.map((r) => r.event_id).sort()).toEqual(["a", "b"]);
  });

  it("skips a partition with only one small file", async () => {
    const s3 = new FakeS3();
    await s3.seed("lake/d/only.parquet", [row("x")], OLD);
    const res = await runCompactionForTarget(TARGET, s3, OPTS);
    expect(res.jobs).toBe(0);
    expect(s3.removed).toEqual([]);
  });

  it("records delete_failed but keeps the merged/rows count when cleanup fails", async () => {
    // The merge fully landed (written + verified); only the source delete
    // failed. We must not lose the merged tally — the originals are harmless
    // duplicates a later tick retries.
    const s3 = new FakeS3();
    await s3.seed("lake/d/part-a.parquet", [row("a1"), row("a2")], OLD);
    await s3.seed("lake/d/part-b.parquet", [row("b1")], OLD);
    s3.remove = async () => {
      throw new Error("DeleteObjects reported 1 failure(s): lake/d/part-a.parquet: AccessDenied");
    };

    const res = await runCompactionForTarget(TARGET, s3, OPTS);

    expect(res.merged).toBe(1); // merge counted despite the delete failure
    expect(res.rows).toBe(3);
    expect(res.deleted).toBe(0); // not over-counted when deletes failed
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/^delete_failed:/);
    // The merged object is present; originals survive for a retry.
    const out = mergedKey("lake/d/", ["lake/d/part-a.parquet", "lake/d/part-b.parquet"]);
    expect(s3.store.has(out)).toBe(true);
    expect(s3.store.has("lake/d/part-a.parquet")).toBe(true);
  });

  it("never re-merges an existing compacted-* object (no row duplication after a failed delete)", async () => {
    // Models the dangerous cycle: a prior tick merged a+b into a small
    // compacted object but FAILED to delete the originals, so a, b AND the
    // compacted file all sit in the partition, all small + old. Without a
    // name-based exclusion the compacted file re-qualifies as a candidate and
    // gets merged WITH the still-present originals — permanently doubling rows.
    const s3 = new FakeS3();
    await s3.seed("lake/d/part-a.parquet", [row("a")], OLD);
    await s3.seed("lake/d/part-b.parquet", [row("b")], OLD);
    const priorCompacted = mergedKey("lake/d/", [
      "lake/d/part-a.parquet",
      "lake/d/part-b.parquet",
    ]);
    await s3.seed(priorCompacted, [row("a"), row("b")], OLD); // small → would re-qualify by size

    const res = await runCompactionForTarget(TARGET, s3, OPTS);

    // The compacted object is never selected as a merge input (not deleted).
    expect(s3.removed).not.toContain(priorCompacted);
    // a + b re-merge into the SAME compacted key (overwrite), carrying exactly
    // the two original rows — NOT [a, a, b, b].
    expect(res.rows).toBe(2);
    const merged = await readParquetRows(s3.store.get(priorCompacted)!.body);
    expect(merged.map((r) => r.event_id).sort()).toEqual(["a", "b"]);
  });

  it("bounds get() concurrency to at most 4 simultaneous reads", async () => {
    // Seed enough small files to force a single job with many inputs, then
    // instrument get() to track peak concurrency. The bounded-map ceiling
    // (GET_CONCURRENCY=4) must hold even with 10 inputs.
    const s3 = new FakeS3();
    for (let i = 0; i < 10; i++) {
      await s3.seed(`lake/c/part-${i}.parquet`, [row(`r${i}`)], OLD);
    }

    let inFlight = 0;
    let peak = 0;
    const realGet = s3.get.bind(s3);
    s3.get = async (bucket, key) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield so overlapping gets actually accumulate before any resolve.
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await realGet(bucket, key);
      } finally {
        inFlight--;
      }
    };

    const res = await runCompactionForTarget(TARGET, s3, {
      ...OPTS,
      maxInputsPerJob: 100, // one job with all 10 inputs
    });

    expect(res.merged).toBe(1);
    expect(res.rows).toBe(10);
    expect(peak).toBeGreaterThan(1); // actually parallel...
    expect(peak).toBeLessThanOrEqual(4); // ...but capped
  });
});
