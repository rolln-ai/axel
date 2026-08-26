import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  loadParquetCompactionRoutes,
  runParquetCompactionTick,
} from "../src/parquet-compaction-runner.ts";
import type { CompactionS3Access } from "../src/parquet-compaction-loop.ts";

/** Minimal Pool stand-in — compaction only calls `query`. */
function fakePool(rows: unknown[]): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

const S3_CONFIG = {
  bucket: "archive",
  region: "us-east-1",
  access_key_id: "AKIA",
  secret_access_key: "secret",
  key_prefix: "lake/",
};

const getDestination = async () => ({ config: S3_CONFIG });

function routeRow(routeId: string, binding: Record<string, unknown> = {}) {
  return {
    route_id: routeId,
    destination_id: "dst-1",
    workspace_id: "ws-1",
    binding: { format: "parquet", ...binding },
  };
}

describe("loadParquetCompactionRoutes", () => {
  it("dedupes routes sharing the same (bucket, prefix) into one target", async () => {
    // Two routes bound to the same destination with no per-route key_prefix
    // list the SAME physical objects. Compacting the prefix once per route
    // would let whichever ran first consume (list/merge/delete) the other's
    // objects under its own identity, leaving the second a wasted LIST over an
    // already-drained prefix.
    const routes = await loadParquetCompactionRoutes(
      fakePool([routeRow("rt-1"), routeRow("rt-2")]),
      getDestination,
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.target.routeId).toBe("rt-1"); // deterministic (query ORDER BY)
    expect(routes[0]?.target.prefix).toBe("lake/");
  });

  it("keeps the smallest parquet_target_bytes among prefix-sharers", async () => {
    const routes = await loadParquetCompactionRoutes(
      fakePool([
        routeRow("rt-1", { parquet_target_bytes: 64 * 1024 * 1024 }),
        routeRow("rt-2", { parquet_target_bytes: 32 * 1024 * 1024 }),
      ]),
      getDestination,
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.target.targetBytes).toBe(32 * 1024 * 1024);
  });

  it("keeps routes with distinct per-route prefixes separate", async () => {
    const routes = await loadParquetCompactionRoutes(
      fakePool([
        routeRow("rt-1", { key_prefix: "lake/rt-1/" }),
        routeRow("rt-2", { key_prefix: "lake/rt-2/" }),
      ]),
      getDestination,
    );
    expect(routes.map((r) => r.target.prefix).sort()).toEqual(["lake/rt-1/", "lake/rt-2/"]);
  });
});

describe("runParquetCompactionTick", () => {
  it("continues with the remaining routes when one route's client construction throws", async () => {
    const listedPrefixes: string[] = [];
    const emptyAccess: CompactionS3Access = {
      async list(_bucket, prefix) {
        listedPrefixes.push(prefix);
        return [];
      },
      async get() {
        throw new Error("unused");
      },
      async put() {},
      async exists() {
        return false;
      },
      async remove() {},
    };

    let constructions = 0;
    await runParquetCompactionTick({
      pool: fakePool([
        // The bad route comes first — its construction failure must not abort
        // the loop before the healthy route runs.
        routeRow("rt-bad", { key_prefix: "bad/" }),
        routeRow("rt-good", { key_prefix: "good/" }),
      ]),
      getDestination,
      intervalMs: 1,
      tickOptions: {
        smallFileBytes: 1,
        minFilesToMerge: 2,
        safetyWindowMs: 1,
        maxInputsPerJob: 2,
      },
      // First construction throws — mirrors the defensive ssrf_blocked throw
      // in createS3CompactionAccess.
      createAccess: () => {
        constructions += 1;
        if (constructions === 1) throw new Error("ssrf_blocked: test");
        return emptyAccess;
      },
    });

    expect(constructions).toBe(2);
    expect(listedPrefixes).toEqual(["good/"]);
  });
});
