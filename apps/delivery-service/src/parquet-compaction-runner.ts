/**
 * Singleton compaction loop (worker role only). Every tick it enumerates the
 * active Parquet S3 routes, builds a credentialed S3 accessor per route, and
 * runs `runCompactionForTarget` to merge small objects into large ones.
 *
 * Gated behind PARQUET_COMPACTION_ENABLED: deploying this code does nothing to
 * any customer bucket until an operator opts in. When enabled, deletes happen
 * only after a verified PUT (see runCompactionForTarget).
 */
import type { Pool } from "pg";
import {
  runCompactionForTarget,
  type CompactionS3Access,
  type CompactionTarget,
  type CompactionTickOptions,
} from "./parquet-compaction-loop.js";
import {
  createS3CompactionAccess,
  type S3CompactionClientConfig,
} from "./connectors/s3-compaction-access.js";
// Same SSRF guard the delivery S3 connector uses (connectors/s3.ts). Applied
// before any network client is built so a DB-set custom endpoint can't aim
// compaction at a metadata / internal host.
import { sanitizeConnectorDiagnosticForStorage, validateDestinationUrl } from "@axel/shared";

const DEFAULT_TARGET_BYTES = 64 * 1024 * 1024;

export interface ParquetCompactionRoute {
  target: CompactionTarget;
  s3: S3CompactionClientConfig;
}

interface GetDestination {
  (workspaceId: string, destinationId: string): Promise<{ config: unknown } | null>;
}

interface ParquetRouteRow {
  route_id: string;
  destination_id: string;
  workspace_id: string;
  binding: unknown;
}

/** Enumerate active Parquet S3 routes and resolve each to a compaction target
 *  plus decrypted S3 credentials. Rows missing required connection fields are
 *  skipped (logged), not failed. */
export async function loadParquetCompactionRoutes(
  pool: Pool,
  getDestination: GetDestination,
): Promise<ParquetCompactionRoute[]> {
  const { rows } = await pool.query<ParquetRouteRow>(
    `SELECT rd.route_id, rd.destination_id, d.workspace_id, rd.binding
       FROM route_destinations rd
       JOIN destinations d ON d.id = rd.destination_id
       JOIN routes r ON r.id = rd.route_id
      WHERE d.type = 's3'
        AND d.status = 'active'
        AND r.status = 'active'
        AND rd.binding->>'format' = 'parquet'
      ORDER BY rd.route_id, rd.destination_id`,
  );

  const out: ParquetCompactionRoute[] = [];
  for (const row of rows) {
    const dest = await getDestination(row.workspace_id, row.destination_id);
    const config = (dest?.config ?? null) as Record<string, unknown> | null;
    if (!config) continue;
    const bucket = str(config.bucket);
    const region = str(config.region);
    const accessKeyId = str(config.access_key_id);
    const secretAccessKey = str(config.secret_access_key);
    if (!bucket || !region || !accessKeyId || !secretAccessKey) {
      console.warn(
        "[compaction] skipping route — incomplete S3 config",
      );
      continue;
    }
    // SSRF guard: a custom (S3-compatible) endpoint must pass the same egress
    // check the delivery path enforces. Skip + warn an unsafe route rather
    // than failing the whole loop (mirrors the incomplete-config skip above).
    const endpoint = str(config.endpoint);
    if (endpoint) {
      const epSsrf = validateDestinationUrl(endpoint);
      if (epSsrf) {
        console.warn(
          `[compaction] skipping route — endpoint blocked: ${sanitizeConnectorDiagnosticForStorage(epSsrf)}`,
        );
        continue;
      }
    }

    const binding = (row.binding ?? {}) as Record<string, unknown>;
    const prefix = str(binding.key_prefix) || str(config.key_prefix) || "";
    const targetBytes = posInt(binding.parquet_target_bytes) ?? DEFAULT_TARGET_BYTES;

    out.push({
      target: {
        workspaceId: row.workspace_id,
        destinationId: row.destination_id,
        routeId: row.route_id,
        bucket,
        prefix,
        targetBytes,
      },
      s3: {
        region,
        accessKeyId,
        secretAccessKey,
        ...(endpoint ? { endpoint } : {}),
        ...(config.addressing_style === "virtual_hosted" || config.addressing_style === "path"
          ? { addressingStyle: config.addressing_style }
          : {}),
      },
    });
  }
  // Compaction is a physical operation on an (endpoint, bucket, prefix)
  // listing, not a logical per-route one: two routes bound to the same S3
  // destination without distinct per-route key prefixes see the SAME objects.
  // Deduplicate so each physical prefix is compacted exactly once per tick —
  // otherwise whichever route ran first would list/merge/delete the other's
  // objects under its own identity, and the loser would relist an
  // already-drained prefix. The query's ORDER BY makes the surviving
  // (attributed) route deterministic; the smallest targetBytes wins so no
  // sharer's parquet_target_bytes is exceeded.
  const byLocation = new Map<string, ParquetCompactionRoute>();
  for (const route of out) {
    const key = `${route.s3.endpoint ?? ""}\n${route.target.bucket}\n${route.target.prefix}`;
    const existing = byLocation.get(key);
    if (!existing) {
      byLocation.set(key, route);
    } else if (route.target.targetBytes < existing.target.targetBytes) {
      existing.target.targetBytes = route.target.targetBytes;
    }
  }
  return [...byLocation.values()];
}

export interface ParquetCompactionLoopDeps {
  pool: Pool;
  getDestination: GetDestination;
  intervalMs: number;
  tickOptions: Omit<CompactionTickOptions, "nowMs">;
  /** Test seam — defaults to the real S3-backed accessor. */
  createAccess?: (config: S3CompactionClientConfig) => CompactionS3Access;
}

export interface RunnerHandle {
  stop(): Promise<void>;
}

/** One compaction pass over all Parquet routes. Exported for tests/manual runs. */
export async function runParquetCompactionTick(deps: ParquetCompactionLoopDeps): Promise<void> {
  const routes = await loadParquetCompactionRoutes(deps.pool, deps.getDestination);
  if (routes.length === 0) return;
  const createAccess = deps.createAccess ?? createS3CompactionAccess;
  let mergedTotal = 0;
  let deletedTotal = 0;
  const nowMs = Date.now();
  for (const route of routes) {
    // Per-route isolation INCLUDING client construction: a route whose
    // accessor can't even be built (e.g. the defensive ssrf_blocked throw in
    // createS3CompactionAccess) must not abort the remaining healthy routes
    // for the whole tick. runCompactionForTarget never throws, so this guard
    // exists for the construction step.
    try {
      const access = createAccess(route.s3);
      const res = await runCompactionForTarget(route.target, access, {
        ...deps.tickOptions,
        nowMs,
      });
      mergedTotal += res.merged;
      deletedTotal += res.deleted;
      for (const e of res.errors) {
        console.error(`[compaction] ${sanitizeConnectorDiagnosticForStorage(e)}`);
      }
    } catch (err) {
      console.error(
        `[compaction] route_failed: ${sanitizeConnectorDiagnosticForStorage(err)}`,
      );
    }
  }
  if (mergedTotal > 0 || deletedTotal > 0) {
    console.log(
      `[compaction] tick complete routes=${routes.length} merged=${mergedTotal} deleted=${deletedTotal}`,
    );
  }
}

/** Start the periodic compaction loop. No-overlap: a self-scheduling timer
 *  re-arms only AFTER the prior tick fully settles, so a slow tick can never
 *  stack or overlap with the next. `stop()` waits for the genuinely in-flight
 *  tick (if any) before resolving, so the caller can safely close the pool
 *  knowing no tick is still using a connection. */
export function startParquetCompactionLoop(deps: ParquetCompactionLoopDeps): RunnerHandle {
  let stopped = false;
  // The promise of the tick currently running, or null between ticks. stop()
  // awaits exactly this (not a stale last-assigned value) so a finished tick
  // doesn't make stop() return while a later one is mid-flight.
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => void runTick(), deps.intervalMs);
    timer.unref?.();
  };

  const runTick = async () => {
    if (stopped) return;
    inFlight = runParquetCompactionTick(deps).catch((err) => {
      console.error(
        `[compaction] tick failed: ${sanitizeConnectorDiagnosticForStorage(err)}`,
      );
    });
    try {
      await inFlight;
    } finally {
      inFlight = null;
      // Re-arm only after this tick has fully settled — never overlapping.
      arm();
    }
  };

  arm();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Await the genuinely in-flight tick (if one is running) so the pool
      // isn't closed out from under it.
      if (inFlight) await inFlight;
    },
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function posInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
