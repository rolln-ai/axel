import { describe, expect, it } from "vitest";
import {
  partitionOf,
  planCompaction,
  type StagedParquetObject,
  type CompactionPlanOptions,
} from "../src/parquet-compaction.ts";

const NOW = 1_000_000_000_000;
const BASE: CompactionPlanOptions = {
  targetBytes: 1000,
  smallFileBytes: 500,
  minFilesToMerge: 2,
  safetyWindowMs: 60_000,
  maxInputsPerJob: 100,
  nowMs: NOW,
};

function obj(key: string, sizeBytes: number, ageMs = BASE.safetyWindowMs + 1): StagedParquetObject {
  return { key, sizeBytes, lastModifiedMs: NOW - ageMs };
}

describe("partitionOf", () => {
  it("returns the directory prefix up to the last slash", () => {
    expect(partitionOf("lake/2026-06-18/part-a.parquet")).toBe("lake/2026-06-18/");
    expect(partitionOf("flat.parquet")).toBe("");
    expect(partitionOf("a/b/c/d.parquet")).toBe("a/b/c/");
  });
});

describe("planCompaction", () => {
  it("merges small files in the same partition into one job", () => {
    const jobs = planCompaction(
      [obj("p/1.parquet", 100), obj("p/2.parquet", 100), obj("p/3.parquet", 100)],
      BASE,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ partition: "p/", totalBytes: 300 });
    expect(jobs[0]?.inputKeys).toEqual(["p/1.parquet", "p/2.parquet", "p/3.parquet"]);
  });

  it("skips files modified within the safety window", () => {
    const jobs = planCompaction(
      [obj("p/1.parquet", 100), obj("p/2.parquet", 100, 5_000 /* too recent */)],
      BASE,
    );
    // Only one eligible file left → below minFilesToMerge → no job.
    expect(jobs).toHaveLength(0);
  });

  it("never rewrites files that are already large", () => {
    const jobs = planCompaction(
      [obj("p/big.parquet", 600 /* >= smallFileBytes */), obj("p/small.parquet", 100)],
      BASE,
    );
    expect(jobs).toHaveLength(0); // big excluded, lone small left alone
  });

  it("keeps partitions separate", () => {
    const jobs = planCompaction(
      [
        obj("a/1.parquet", 100),
        obj("a/2.parquet", 100),
        obj("b/1.parquet", 100),
        obj("b/2.parquet", 100),
      ],
      BASE,
    );
    expect(jobs.map((j) => j.partition).sort()).toEqual(["a/", "b/"]);
    expect(jobs).toHaveLength(2);
  });

  it("bin-packs into multiple jobs once the byte target is reached", () => {
    // 5 × 400B = 2000B, target 1000B → first job fills at 800→1200 (2 files),
    // packing stops once bytes >= target.
    const jobs = planCompaction(
      [
        obj("p/1.parquet", 400),
        obj("p/2.parquet", 400),
        obj("p/3.parquet", 400),
        obj("p/4.parquet", 400),
        obj("p/5.parquet", 400),
      ],
      BASE,
    );
    // 400+400=800 (<1000, continue) +400=1200 (>=1000, flush) → job of 3;
    // then 400+400=800 (<1000) → trailing bucket of 2 → job of 2.
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.inputKeys).toHaveLength(3);
    expect(jobs[1]?.inputKeys).toHaveLength(2);
  });

  it("respects maxInputsPerJob even when far below the byte target", () => {
    const tiny = Array.from({ length: 5 }, (_, i) => obj(`p/${i}.parquet`, 10));
    const jobs = planCompaction(tiny, { ...BASE, maxInputsPerJob: 2 });
    // 5 files, cap 2 → jobs of [2, 2], trailing 1 dropped (below min).
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.inputKeys.length === 2)).toBe(true);
  });

  it("does not emit a job for a lone straggler", () => {
    const jobs = planCompaction([obj("p/only.parquet", 100)], BASE);
    expect(jobs).toHaveLength(0);
  });

  it("orders inputs oldest-first within a partition", () => {
    const jobs = planCompaction(
      [obj("p/new.parquet", 100, 70_000), obj("p/old.parquet", 100, 120_000)],
      BASE,
    );
    expect(jobs[0]?.inputKeys).toEqual(["p/old.parquet", "p/new.parquet"]);
  });
});
