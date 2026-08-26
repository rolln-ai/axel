import pg from "pg";
import {
  controlPlanePgSslOption,
  requireEnv,
  resolveIngestBaseUrl,
  sanitizeConnectorDiagnosticForStorage,
} from "@axel/shared";
import { captureException, installNodeSentryHandlers, isTransientPostgresError, recordHeartbeat, sentryClientFromEnv, withCronCheckIn } from "@axel/observability";
import { PullBatchError, runActivePullSources } from "./index.js";

const DATABASE_URL = requireEnv(process.env, "DATABASE_URL");
const INTERVAL_MS = Number.parseInt(process.env.PULL_WORKER_INTERVAL_MS ?? "60000", 10);
// A pull tick can legitimately spend several minutes paging a source. Sentry's
// schedule describes the liveness SLA, not the one-minute polling cadence;
// otherwise every healthy long-running sync opens a false "missed" monitor.
const MONITOR_INTERVAL_MINUTES = Number.parseInt(
  process.env.PULL_WORKER_MONITOR_INTERVAL_MINUTES ?? "30",
  10,
);
const MONITOR_CHECKIN_MARGIN_MINUTES = 5;
const MONITOR_MAX_RUNTIME_MINUTES = 30;
const INGEST_URL = resolveIngestBaseUrl(process.env);
const sentry = sentryClientFromEnv(process.env, "pull-worker");
installNodeSentryHandlers(sentry);

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10),
  ssl: controlPlanePgSslOption(DATABASE_URL, process.env.CONTROL_PLANE_DB_SSL_VERIFY),
  // Fail a hung dial fast (matches delivery-service) rather than pg's default
  // of waiting forever — a stalled connect should surface as a transient the
  // tick can retry, not block the whole worker.
  connectionTimeoutMillis: 8_000,
});

pool.on("error", (err) => {
  // node-postgres emits idle-client failures on the Pool itself. Without an
  // error listener, EventEmitter turns a routine socket abort into an
  // uncaughtException and terminates the whole pull worker.
  console.error("[control-pool] async error (handled):", safePullDiagnostic(err));
  if (isTransientPostgresError(err)) return;
  void captureException(sentry, err, { tags: { component: "postgres_pool" } });
});

const clickhouse = process.env.CLICKHOUSE_URL
  ? {
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL,
      ...(process.env.CLICKHOUSE_USER ? { CLICKHOUSE_USER: process.env.CLICKHOUSE_USER } : {}),
      ...(process.env.CLICKHOUSE_PASSWORD ? { CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD } : {}),
    }
  : undefined;

let tickCount = 0;
let tickInFlight = false;
let lastTickError: string | undefined;
let lastSourcesProcessed = 0;

function beatPullWorker(): void {
  void recordHeartbeat(pool, {
    component: "pull-worker",
    tickCount,
    ...(lastTickError ? { error: lastTickError } : {}),
    metadata: {
      sources_processed: lastSourcesProcessed,
      tick_in_flight: tickInFlight,
    },
    // The independent heartbeat timer runs every polling interval. Allow one
    // missed beat before yellow; deriveStatus marks red after a second window.
    expectedIntervalSeconds: Math.ceil((INTERVAL_MS / 1000) * 2),
    environment: process.env.NODE_ENV ?? "production",
  });
}

async function tick(): Promise<void> {
  tickCount += 1;
  let lastError: string | undefined;
  let summaries: Awaited<ReturnType<typeof runActivePullSources>> = [];
  try {
    summaries = await withCronCheckIn(
      sentry,
      {
        slug: "pull-worker-tick",
        monitorConfig: {
          schedule: {
            type: "interval",
            value: Math.max(1, MONITOR_INTERVAL_MINUTES),
            unit: "minute",
          },
          checkin_margin: MONITOR_CHECKIN_MARGIN_MINUTES,
          max_runtime: MONITOR_MAX_RUNTIME_MINUTES,
          timezone: "UTC",
        },
      },
      async () => runActivePullSources({
        pool,
        ingestUrl: INGEST_URL,
        ...(clickhouse ? { clickhouse } : {}),
      }),
    );
    lastTickError = undefined;
    lastSourcesProcessed = summaries.length;
    if (summaries.length > 0) {
      console.log("[pull-worker] completed", JSON.stringify({
        sources: summaries.length,
        streams: summaries.reduce((count, summary) => count + summary.streams.length, 0),
        records: summaries.reduce(
          (count, summary) => count + summary.streams.reduce((sum, stream) => sum + stream.records, 0),
          0,
        ),
      }));
    }
  } catch (err) {
    lastError = err instanceof PullBatchError ? "pull_batch_failed" : safePullDiagnostic(err);
    lastTickError = lastError;
    if (err instanceof PullBatchError) {
      lastSourcesProcessed = err.attempted;
    }
    throw err;
  } finally {
    beatPullWorker();
  }
}

const timer = setInterval(() => {
  if (tickInFlight) {
    console.log("[pull-worker] previous tick still running; skipping interval");
    return;
  }
  tickInFlight = true;
  tick().catch((err) => {
    if (err instanceof PullBatchError) {
      // Per-source details were already recorded on pull_sync_runs/logged by
      // runActivePullSources. The failed cron check-in + red heartbeat are the
      // aggregate signal; do not open a duplicate Sentry exception each minute.
      console.error(`[pull-worker] ${err.message}`);
      return;
    }
    console.error(`[pull-worker] tick failed: ${safePullDiagnostic(err)}`);
    // Drop transient pg pooler blips so we don't open a Sentry fingerprint
    // per failover (same pattern as delivery-service). The next tick will
    // re-acquire a healthy connection.
    if (isTransientPostgresError(err)) return;
    void captureException(sentry, err, { tags: { component: "pull_worker_tick" } });
  }).finally(() => {
    tickInFlight = false;
  });
}, INTERVAL_MS);

// Keep liveness fresh while a legitimate multi-page tick is running. Without
// this independent beat, a healthy worker looked stalled until the sync ended.
const heartbeatTimer = setInterval(beatPullWorker, INTERVAL_MS);

tickInFlight = true;
tick().catch((err) => {
  if (err instanceof PullBatchError) {
    console.error(`[pull-worker] ${err.message}`);
    return;
  }
  console.error(`[pull-worker] initial tick failed: ${safePullDiagnostic(err)}`);
  if (isTransientPostgresError(err)) return;
  void captureException(sentry, err, { tags: { component: "pull_worker_initial_tick" } });
}).finally(() => {
  tickInFlight = false;
});

process.on("SIGTERM", async () => {
  clearInterval(timer);
  clearInterval(heartbeatTimer);
  await pool.end();
  process.exit(0);
});

function safePullDiagnostic(value: unknown): string {
  return sanitizeConnectorDiagnosticForStorage(
    value instanceof Error ? value.message : value,
    500,
  ) || "pull_worker_failed";
}
