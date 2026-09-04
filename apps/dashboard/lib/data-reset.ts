import "server-only";
import { MongoClient } from "mongodb";
import { Pool } from "pg";
import {
  cloudflareR2ObjectUrl,
  pgSslOption,
  resolveRawPayloadBucket,
  validateDestinationUrl,
} from "@axel/shared";
import { db, type Queryable } from "./db";
import { clickhouse, hasClickhouseUrl, type ClickhouseQueryable } from "./clickhouse";
import { credentialAad, decryptCredentialBlob } from "./credentials";
import type { DestinationType } from "./destination-defaults";
import { createSafePgStream, safeDashboardFetch, safeLookup } from "./safe-egress";

const R2_DELETE_BATCH_SIZE = 10_000;
// Cloudflare returns 429 (code 971, "consider throttling") under sustained
// parallel deletes. Kept modest, with adaptive pacing between batches; teardown
// runs in the background now, so slower-but-steady beats fast-and-throttled.
const R2_DELETE_CONCURRENCY = 4;
const R2_DELETE_MAX_ATTEMPTS = 10;
// Cool-down inserted between batches only after Cloudflare throttles, to relieve
// sustained pressure rather than only backing off per-request.
const R2_THROTTLE_COOLDOWN_MS = 2_000;
// One admin request deletes a native R2 page (<=1,000 objects). Bound the
// number and wall time per cron invocation so a million-object workspace
// advances durably without approaching Vercel's 300-second hard stop.
const R2_PURGE_BATCHES_PER_RUN = 100;
const R2_PURGE_TIME_BUDGET_MS = 90_000;
const R2_PURGE_REQUEST_TIMEOUT_MS = 30_000;
const R2_PURGE_PACE_MS = 100;
const POSTGRES_DELETE_BATCH_SIZE = 10_000;
const POSTGRES_DELETE_MAX_ROWS_PER_RUN = 100_000;
const OPERATIONAL_TABLES = [
  // Derived from sampled events. Contracts and versions are configuration and
  // stay, but event-linked fixture/drift rows are part of an event-data wipe.
  "data_contract_fixtures",
  "data_contract_drift_events",
  "replay_requests",
  "dead_letters",
  "delivery_idempotency",
  "erasure_subjects",
] as const;
const CLICKHOUSE_TABLES = [
  "delivery_attempts",
  "route_evaluations",
  "events",
  // Materialized-view targets retain their own physical rows; deleting from
  // the source MergeTree tables does not retract data already emitted here.
  "events_daily",
  "delivery_latest_outcomes",
  "delivery_base_latest_outcomes",
] as const;
const DESTINATION_CONNECTION_TIMEOUT_MS = 8_000;
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SAFE_DATABRICKS_IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface WorkspaceDataWipeOptions {
  includeRawPayloads: boolean;
  deps?: {
    clickhouse?: ClickhouseQueryable;
    pg?: Queryable;
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
    /** Absolute wall-clock deadline shared by the enclosing teardown sweep. */
    deadlineMs?: number;
    /** Unit-test override; production uses the bounded constant above. */
    r2MaxBatches?: number;
    /** Unit-test override for the short pause between native R2 pages. */
    r2PaceMs?: number;
  };
}

export interface WorkspaceDataWipeResult {
  clickhouseTables: string[];
  postgresRows: number;
  r2Deleted: number;
  r2Skipped: boolean;
  r2LimitReached: boolean;
  postgresLimitReached: boolean;
  clickhouseLimitReached: boolean;
}

export interface FlushableDestination {
  id: string;
  name: string;
  type: DestinationType;
  supported: boolean;
  detail: string;
}

export interface DestinationFlushResult {
  destinationId: string;
  type: DestinationType;
  detail: string;
}

export interface FlushAllDestinationsResult {
  attempted: number;
  flushed: DestinationFlushResult[];
  skipped: FlushableDestination[];
  failed: Array<{ destinationId: string; name: string; type: DestinationType; error: string }>;
}

interface DestinationRowWithBlob {
  id: string;
  workspace_id: string;
  name: string | null;
  type: DestinationType;
  config: Record<string, unknown>;
  credentials_ref: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  auth_tag: Buffer | null;
  encryption_version: number | null;
}

export async function wipeWorkspaceData(
  workspaceId: string,
  options: WorkspaceDataWipeOptions,
): Promise<WorkspaceDataWipeResult> {
  const r2 = options.includeRawPayloads
    ? await deleteWorkspaceRawPayloads(workspaceId, options.deps)
    : { deleted: 0, skipped: true, complete: true };

  if (!r2.complete) {
    return {
      clickhouseTables: [],
      postgresRows: 0,
      r2Deleted: r2.deleted,
      r2Skipped: r2.skipped,
      r2LimitReached: true,
      postgresLimitReached: false,
      clickhouseLimitReached: false,
    };
  }

  const postgres = await deleteWorkspaceOperationalRows(workspaceId, options.deps);
  if (!postgres.complete) {
    return {
      clickhouseTables: [],
      postgresRows: postgres.deleted,
      r2Deleted: r2.deleted,
      r2Skipped: r2.skipped,
      r2LimitReached: false,
      postgresLimitReached: true,
      clickhouseLimitReached: false,
    };
  }

  if (Date.now() >= (options.deps?.deadlineMs ?? Number.POSITIVE_INFINITY)) {
    return {
      clickhouseTables: [],
      postgresRows: postgres.deleted,
      r2Deleted: r2.deleted,
      r2Skipped: r2.skipped,
      r2LimitReached: false,
      postgresLimitReached: false,
      clickhouseLimitReached: true,
    };
  }

  const clickhouse = await advanceWorkspaceClickhouseDelete(
    workspaceId,
    options.deps?.clickhouse,
  );

  return {
    clickhouseTables: clickhouse.tables,
    postgresRows: postgres.deleted,
    r2Deleted: r2.deleted,
    r2Skipped: r2.skipped,
    r2LimitReached: false,
    postgresLimitReached: false,
    clickhouseLimitReached: !clickhouse.complete,
  };
}

async function listWorkspaceRawPayloadKeys(
  workspaceId: string,
  after: string,
  ch?: ClickhouseQueryable,
): Promise<string[]> {
  if (!hasClickhouseUrl()) return [];
  const client = ch ?? clickhouse();
  const result = await client.query<{ r2_key: string }>(
    `SELECT DISTINCT r2_key
       FROM events
      WHERE workspace_id = {workspace_id:String}
        AND startsWith(r2_key, {prefix:String})
        AND r2_key > {after:String}
      ORDER BY r2_key
      LIMIT {limit:UInt32}`,
    {
      workspace_id: workspaceId,
      prefix: `events/${workspaceId}/`,
      after,
      limit: R2_DELETE_BATCH_SIZE,
    },
  );
  return result.rows.map((row) => row.r2_key).filter(Boolean);
}

async function advanceWorkspaceClickhouseDelete(
  workspaceId: string,
  ch?: ClickhouseQueryable,
): Promise<{ tables: string[]; complete: boolean }> {
  if (!hasClickhouseUrl()) return { tables: [], complete: true };
  const client = ch ?? clickhouse();

  // Mutations are asynchronous so the request never waits behind a multi-
  // million-row rewrite. A later cron observes the pending mutation or, once
  // it is done, verifies that no workspace rows remain before hard deletion.
  const pending = await client.query<{ table_name: string; latest_fail_reason: string }>(
    `SELECT table AS table_name, latest_fail_reason
       FROM system.mutations
      WHERE database = currentDatabase()
        AND table IN (
          'delivery_attempts', 'route_evaluations', 'events',
          'events_daily', 'delivery_latest_outcomes', 'delivery_base_latest_outcomes'
        )
        AND is_done = 0
        AND position(command, {workspace_id:String}) > 0`,
    { workspace_id: workspaceId },
  );
  const failed = pending.rows.find((row) => row.latest_fail_reason);
  if (failed) {
    throw new Error(`clickhouse_workspace_delete_failed:${failed.table_name}`);
  }
  if (pending.rows.length > 0) {
    return { tables: pending.rows.map((row) => row.table_name), complete: false };
  }

  const counts = await client.query<{ table_name: string; row_count: string }>(
    `SELECT 'delivery_attempts' AS table_name, count() AS row_count
       FROM delivery_attempts WHERE workspace_id = {workspace_id:String}
     UNION ALL
     SELECT 'route_evaluations' AS table_name, count() AS row_count
       FROM route_evaluations WHERE workspace_id = {workspace_id:String}
     UNION ALL
     SELECT 'events' AS table_name, count() AS row_count
       FROM events WHERE workspace_id = {workspace_id:String}
     UNION ALL
     SELECT 'events_daily' AS table_name, count() AS row_count
       FROM events_daily WHERE workspace_id = {workspace_id:String}
     UNION ALL
     SELECT 'delivery_latest_outcomes' AS table_name, count() AS row_count
       FROM delivery_latest_outcomes WHERE workspace_id = {workspace_id:String}
     UNION ALL
     SELECT 'delivery_base_latest_outcomes' AS table_name, count() AS row_count
       FROM delivery_base_latest_outcomes WHERE workspace_id = {workspace_id:String}`,
    { workspace_id: workspaceId },
  );
  const tables = counts.rows
    .filter((row) => Number(row.row_count) > 0)
    .map((row) => row.table_name)
    .filter((table): table is (typeof CLICKHOUSE_TABLES)[number] =>
      CLICKHOUSE_TABLES.includes(table as (typeof CLICKHOUSE_TABLES)[number]));
  if (tables.length === 0) return { tables: [], complete: true };

  for (const table of tables) {
    await client.query(
      `ALTER TABLE ${table}
        DELETE WHERE workspace_id = {workspace_id:String}
        SETTINGS mutations_sync = 0`,
      { workspace_id: workspaceId },
    );
  }
  return { tables, complete: false };
}

async function deleteWorkspaceOperationalRows(
  workspaceId: string,
  deps: WorkspaceDataWipeOptions["deps"] = {},
): Promise<{ deleted: number; complete: boolean }> {
  const pg = deps.pg ?? db();
  const deadline = deps.deadlineMs ?? Number.POSITIVE_INFINITY;
  let deleted = 0;
  for (const table of OPERATIONAL_TABLES) {
    while (deleted < POSTGRES_DELETE_MAX_ROWS_PER_RUN && Date.now() < deadline) {
      const limit = Math.min(
        POSTGRES_DELETE_BATCH_SIZE,
        POSTGRES_DELETE_MAX_ROWS_PER_RUN - deleted,
      );
      const result = await pg.query(
        `DELETE FROM ${table}
          WHERE ctid IN (
            SELECT ctid FROM ${table}
             WHERE workspace_id = $1
             LIMIT $2
          )`,
        [workspaceId, limit],
      );
      const rowCount = result.rowCount ?? 0;
      deleted += rowCount;
      if (rowCount < limit) break;
    }
    if (deleted >= POSTGRES_DELETE_MAX_ROWS_PER_RUN) {
      return { deleted, complete: false };
    }
    if (Date.now() >= deadline) return { deleted, complete: false };
  }
  return { deleted, complete: true };
}

async function deleteWorkspaceRawPayloads(
  workspaceId: string,
  deps: WorkspaceDataWipeOptions["deps"] = {},
): Promise<{ deleted: number; skipped: boolean; complete: boolean }> {
  const env = deps.env ?? process.env;
  const adminEndpoint = workspacePayloadDeleteEndpoint(env);
  if (adminEndpoint && env.INGEST_ADMIN_TOKEN) {
    return await deleteWorkspaceRawPayloadsViaIngest(
      workspaceId,
      adminEndpoint,
      env.INGEST_ADMIN_TOKEN,
      deps,
    );
  }
  if (!env.CLOUDFLARE_R2_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return { deleted: 0, skipped: true, complete: true };
  }
  if (!hasClickhouseUrl()) return { deleted: 0, skipped: false, complete: true };

  // Legacy fallback for small/dev workspaces. A full ClickHouse page means the
  // workload may exceed a serverless invocation; refuse explicitly instead of
  // restarting the same in-memory cursor forever. Production is configured to
  // use the native ingest-worker R2 binding above.
  const keys = await listWorkspaceRawPayloadKeys(workspaceId, "", deps.clickhouse);
  if (keys.length >= R2_DELETE_BATCH_SIZE) {
    throw new Error("r2_bulk_purge_required: configure INGEST_ADMIN_URL and INGEST_ADMIN_TOKEN");
  }
  const deleted = keys.length > 0 ? (await deleteR2Objects(keys, deps)).deleted : 0;

  return { deleted, skipped: false, complete: true };
}

function workspacePayloadDeleteEndpoint(
  env: Record<string, string | undefined>,
): string | null {
  const raw = env.INGEST_ADMIN_URL;
  if (!raw) return null;
  const base = raw
    .replace(/\/admin\/(?:source-cache\/(?:invalidate|put)|source-authority\/(?:fence|sync))\/?$/, "")
    .replace(/\/$/, "");
  return `${base}/admin/workspace-payloads/delete-batch`;
}

/**
 * Distinct non-default r2-destination mirror prefixes for a workspace, as
 * `<key_prefix>/<workspaceId>/` object prefixes. r2-type destinations write
 * delivered payloads to our own bucket under `{key_prefix|"deliveries"}/{ws}/…`;
 * the ingest teardown already sweeps the "deliveries" default, so we only return
 * custom prefixes here. The endpoint re-validates that each is workspace-scoped.
 */
async function enumerateCustomR2Prefixes(
  workspaceId: string,
  deps: WorkspaceDataWipeOptions["deps"] = {},
): Promise<string[]> {
  const pg = deps.pg ?? db();
  const res = await pg.query<{ prefix: string | null }>(
    `SELECT DISTINCT coalesce(rd.binding->>'key_prefix', d.config->>'key_prefix', 'deliveries') AS prefix
       FROM destinations d
       LEFT JOIN route_destinations rd ON rd.destination_id = d.id
      WHERE d.workspace_id = $1 AND d.type = 'r2'`,
    [workspaceId],
  );
  const out = new Set<string>();
  for (const row of res.rows) {
    const kp = (row.prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
    // "deliveries" (and an empty bucket-root prefix) are already covered by the
    // default sweep; only forward filesystem-safe custom prefixes.
    if (!kp || kp === "deliveries") continue;
    if (!/^[A-Za-z0-9._/-]+$/.test(kp)) continue;
    out.add(`${kp}/${workspaceId}/`);
  }
  return [...out];
}

async function deleteWorkspaceRawPayloadsViaIngest(
  workspaceId: string,
  endpoint: string,
  token: string,
  deps: WorkspaceDataWipeOptions["deps"],
): Promise<{ deleted: number; skipped: boolean; complete: boolean }> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const maxBatches = Math.max(1, deps?.r2MaxBatches ?? R2_PURGE_BATCHES_PER_RUN);
  const paceMs = Math.max(0, deps?.r2PaceMs ?? R2_PURGE_PACE_MS);
  const deadline = Math.min(
    Date.now() + R2_PURGE_TIME_BUDGET_MS,
    deps?.deadlineMs ?? Number.POSITIVE_INFINITY,
  );
  // Custom r2-destination mirror prefixes (beyond the default "deliveries") that
  // the ingest worker can't know about — enumerate them once so teardown sweeps
  // every mirror family for the workspace, not just the default.
  const extraPrefixes = await enumerateCustomR2Prefixes(workspaceId, deps);
  let deleted = 0;

  for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch += 1) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(R2_PURGE_REQUEST_TIMEOUT_MS, remainingMs),
    );
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-axel-admin-token": token,
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          confirmation: `delete:${workspaceId}`,
          ...(extraPrefixes.length > 0 ? { extra_prefixes: extraPrefixes } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`r2_bulk_purge_${response.status}`);
      }
      const text = await response.text();
      let result: { workspace_id?: unknown; deleted?: unknown; complete?: unknown };
      try {
        result = JSON.parse(text) as typeof result;
      } catch {
        throw new Error("r2_bulk_purge_invalid_json");
      }
      if (
        result.workspace_id !== workspaceId ||
        typeof result.deleted !== "number" ||
        result.deleted < 0 ||
        typeof result.complete !== "boolean"
      ) {
        throw new Error("r2_bulk_purge_invalid_response");
      }
      deleted += result.deleted;
      if (result.complete) return { deleted, skipped: false, complete: true };
      if (paceMs > 0) await sleep(paceMs);
    } catch (err) {
      // R2 can slow an individual native bulk delete under sustained purge
      // load, including the first request after a prior Worker invocation is
      // still finishing. Treat request timeouts as a resumable no-progress
      // pass; auth, routing, and malformed-response failures still surface
      // immediately because they are not AbortErrors.
      if (isAbortError(err)) {
        return { deleted, skipped: false, complete: false };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return { deleted, skipped: false, complete: false };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export async function deleteR2Objects(
  keys: string[],
  deps: WorkspaceDataWipeOptions["deps"] = {},
): Promise<{ deleted: number; skipped: boolean }> {
  const env = deps.env ?? process.env;
  const token = env.CLOUDFLARE_R2_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = resolveRawPayloadBucket(env);
  if (!token || !accountId || keys.length === 0) {
    return { deleted: 0, skipped: !token || !accountId };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let deleted = 0;
  for (let i = 0; i < keys.length; i += R2_DELETE_CONCURRENCY) {
    const batch = keys.slice(i, i + R2_DELETE_CONCURRENCY);
    const results = await Promise.all(batch.map((key) => deleteR2ObjectWithRetry(
      key,
      accountId,
      bucket,
      token,
      fetchImpl,
    )));
    deleted += results.reduce((sum, r) => sum + r.deleted, 0);
    // Only pace when Cloudflare actually pushed back — the happy path stays at
    // full speed so large workspaces don't crawl. A throttled batch cools down
    // before the next one to relieve sustained pressure (beyond per-request
    // backoff), which is what triggers the 429 (code 971) storms.
    if (results.some((r) => r.throttled) && i + R2_DELETE_CONCURRENCY < keys.length) {
      await sleep(R2_THROTTLE_COOLDOWN_MS);
    }
  }
  return { deleted, skipped: false };
}

async function deleteR2ObjectWithRetry(
  key: string,
  accountId: string,
  bucket: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ deleted: number; throttled: boolean }> {
  const url = cloudflareR2ObjectUrl(accountId, bucket, key);
  let lastStatus = 0;
  let sawThrottle = false;

  for (let attempt = 1; attempt <= R2_DELETE_MAX_ATTEMPTS; attempt++) {
    let throttled = false;
    try {
      const res = await fetchImpl(url, {
        method: "DELETE",
        redirect: "manual",
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok || res.status === 404) return { deleted: 1, throttled: sawThrottle };

      lastStatus = res.status;
      const responseBody = await res.text().catch(() => "");
      throttled = isR2ThrottleResponse(res.status, responseBody);
      if (throttled) sawThrottle = true;
      if (!isRetriableR2Status(res.status) || attempt === R2_DELETE_MAX_ATTEMPTS) break;
    } catch {
      lastStatus = 0;
      if (attempt === R2_DELETE_MAX_ATTEMPTS) break;
    }

    await sleep(r2RetryDelayMs(attempt, throttled));
  }

  throw new Error(`r2_delete_${lastStatus || "network"}`);
}

function isRetriableR2Status(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isR2ThrottleResponse(status: number, body: string): boolean {
  return status === 429 || body.includes("\"code\":971") || body.toLowerCase().includes("throttling");
}

function r2RetryDelayMs(attempt: number, throttled: boolean): number {
  const base = throttled ? 1_000 : 200;
  const cap = throttled ? 15_000 : 2_000;
  return Math.min(cap, base * 2 ** (attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listFlushableDestinations(workspaceId: string): Promise<FlushableDestination[]> {
  const result = await db().query<{
    id: string;
    name: string | null;
    type: DestinationType;
    config: Record<string, unknown>;
  }>(
    `SELECT d.id,
            to_jsonb(d)->>'name' AS name,
            d.type,
            d.config
       FROM destinations d
      WHERE d.workspace_id = $1
      ORDER BY COALESCE(to_jsonb(d)->>'name', d.id) ASC`,
    [workspaceId],
  );

  return result.rows.map((row) => {
    const detail = destinationFlushDetail(row.type, row.config);
    return {
      id: row.id,
      name: row.name ?? row.id,
      type: row.type,
      supported: detail.supported,
      detail: detail.detail,
    };
  });
}

function destinationFlushDetail(
  type: DestinationType,
  config: Record<string, unknown>,
): { supported: boolean; detail: string } {
  if (type === "postgres") return { supported: true, detail: `TRUNCATE ${String(config.table ?? "(missing table)")}` };
  if (type === "mongodb") return { supported: true, detail: `deleteMany({}) in ${String(config.database ?? "(missing db)")}.${String(config.collection ?? "(missing collection)")}` };
  if (type === "databricks_sql") return { supported: true, detail: `TRUNCATE TABLE ${String(config.catalog ?? "")}.${String(config.schema_name ?? "")}.${String(config.table ?? "")}` };
  if (type === "databricks_volume") {
    const prefix = String(config.key_prefix ?? "").replace(/^\/+|\/+$/g, "");
    // `volume` is a per-route binding (route_destinations.binding.volume), NOT a
    // destination config field, so it isn't known here — describe the target
    // generically instead of rendering a misleading empty volume segment.
    const base = `/Volumes/${String(config.catalog ?? "")}/${String(config.schema_name ?? "")}/<each route's volume>/`;
    return {
      supported: true,
      detail: prefix.length > 0 ? `delete ${base}${prefix}/` : `delete every file under ${base}`,
    };
  }
  if (type === "r2") return { supported: false, detail: "target object listing is not available for shared R2 destinations yet" };
  return { supported: false, detail: "not supported for automated flushing" };
}

export async function flushDestinationData(
  workspaceId: string,
  destinationId: string,
): Promise<DestinationFlushResult> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row) throw new Error("destination_not_found");

  if (row.type === "postgres") return await flushPostgres(row);
  if (row.type === "mongodb") return await flushMongo(row);
  if (row.type === "databricks_sql") return await flushDatabricksSql(row);
  if (row.type === "databricks_volume") return await flushDatabricksVolume(row);
  if (row.type === "r2") throw new Error("unsupported_destination_flush:r2");
  throw new Error(`unsupported_destination_flush:${row.type}`);
}

export async function flushAllDestinationData(workspaceId: string): Promise<FlushAllDestinationsResult> {
  const destinations = await listFlushableDestinations(workspaceId);
  const supported = destinations.filter((destination) => destination.supported);
  const flushed: DestinationFlushResult[] = [];
  const failed: FlushAllDestinationsResult["failed"] = [];

  for (const destination of supported) {
    try {
      flushed.push(await flushDestinationData(workspaceId, destination.id));
    } catch {
      failed.push({
        destinationId: destination.id,
        name: destination.name,
        type: destination.type,
        error: "destination_flush_failed",
      });
    }
  }

  return {
    attempted: supported.length,
    flushed,
    skipped: destinations.filter((destination) => !destination.supported),
    failed,
  };
}

async function loadDestinationWithBlob(
  destinationId: string,
  workspaceId: string,
): Promise<DestinationRowWithBlob | null> {
  const result = await db().query<DestinationRowWithBlob>(
    `SELECT d.id,
            d.workspace_id,
            to_jsonb(d)->>'name' AS name,
            d.type,
            d.config,
            d.credentials_ref,
            dc.ciphertext, dc.nonce, dc.auth_tag, dc.encryption_version
       FROM destinations d
       LEFT JOIN destination_credentials dc ON dc.id = d.credentials_ref
      WHERE d.id = $1 AND d.workspace_id = $2
      LIMIT 1`,
    [destinationId, workspaceId],
  );
  return result.rows[0] ?? null;
}

async function decryptedSecrets(row: DestinationRowWithBlob): Promise<Record<string, string>> {
  if (!row.credentials_ref || !row.ciphertext || !row.nonce || !row.auth_tag) return {};
  const plaintext = await decryptCredentialBlob(
    {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      auth_tag: row.auth_tag,
      ...(row.encryption_version != null ? { encryption_version: row.encryption_version } : {}),
    },
    credentialAad(row.workspace_id, row.id),
  );
  if (!plaintext.trim()) return {};
  try {
    return JSON.parse(plaintext) as Record<string, string>;
  } catch {
    throw new Error("invalid_destination_credentials_json");
  }
}

function quoteIdent(input: string): string {
  if (!SAFE_IDENT.test(input)) throw new Error(`identifier_rejected:${input}`);
  return `"${input}"`;
}

function quoteDatabricksIdent(input: string): string {
  if (!SAFE_DATABRICKS_IDENT.test(input)) throw new Error(`identifier_rejected:${input}`);
  return `\`${input}\``;
}

async function flushPostgres(row: DestinationRowWithBlob): Promise<DestinationFlushResult> {
  const secrets = await decryptedSecrets(row);
  const connStr = secrets.connection_string;
  const table = String(row.config.table ?? "");
  if (!connStr) throw new Error("missing_connection_string");
  if (!table) throw new Error("missing_table");

  const pool = new Pool({
    connectionString: connStr,
    stream: createSafePgStream,
    ssl: pgSslOption(connStr),
    connectionTimeoutMillis: DESTINATION_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    await pool.query(`TRUNCATE TABLE ${quoteIdent(table)}`);
  } finally {
    await pool.end();
  }
  return { destinationId: row.id, type: row.type, detail: `Truncated ${table}.` };
}

async function flushMongo(row: DestinationRowWithBlob): Promise<DestinationFlushResult> {
  const secrets = await decryptedSecrets(row);
  const connStr = secrets.connection_string;
  const database = String(row.config.database ?? "");
  const collectionName = String(row.config.collection ?? "");
  if (!connStr) throw new Error("missing_connection_string");
  if (!database) throw new Error("missing_database");
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(collectionName)) throw new Error(`identifier_rejected:${collectionName}`);

  const client = new MongoClient(connStr, {
    serverSelectionTimeoutMS: DESTINATION_CONNECTION_TIMEOUT_MS,
    connectTimeoutMS: DESTINATION_CONNECTION_TIMEOUT_MS,
    maxPoolSize: 1,
    lookup: safeLookup,
  });
  try {
    await client.connect();
    const result = await client.db(database).collection(collectionName).deleteMany({});
    return { destinationId: row.id, type: row.type, detail: `Deleted ${result.deletedCount} documents from ${database}.${collectionName}.` };
  } finally {
    await client.close();
  }
}

async function flushDatabricksSql(row: DestinationRowWithBlob): Promise<DestinationFlushResult> {
  const config = row.config;
  const tableRef = [
    quoteDatabricksIdent(String(config.catalog ?? "")),
    quoteDatabricksIdent(String(config.schema_name ?? "")),
    quoteDatabricksIdent(String(config.table ?? "")),
  ].join(".");
  await runDatabricksStatement(row, `TRUNCATE TABLE ${tableRef}`);
  return { destinationId: row.id, type: row.type, detail: `Truncated ${tableRef}.` };
}

/**
 * The Databricks volume name is a PER-ROUTE binding stored in
 * `route_destinations.binding.volume` (see pipeline-binding.ts), NOT a field on
 * `destinations.config`. Return the distinct, non-empty volumes this destination
 * is bound to across all of its routes.
 */
async function loadDestinationVolumeBindings(destinationId: string): Promise<string[]> {
  const res = await db().query<{ binding: unknown }>(
    `SELECT DISTINCT binding FROM route_destinations WHERE destination_id = $1`,
    [destinationId],
  );
  const volumes = new Set<string>();
  for (const r of res.rows) {
    const b = r.binding;
    if (b && typeof b === "object" && "volume" in b) {
      const v = String((b as { volume?: unknown }).volume ?? "").trim();
      if (v) volumes.add(v);
    }
  }
  return [...volumes];
}

async function flushDatabricksVolume(row: DestinationRowWithBlob): Promise<DestinationFlushResult> {
  const config = row.config;
  const secrets = await decryptedSecrets(row);
  const token = secrets.access_token;
  const host = String(config.workspace_host ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const prefix = String(config.key_prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (!token) throw new Error("missing_access_token");
  if (!host) throw new Error("missing_workspace_host");
  // SSRF guard at egress — workspace_host has no create/update url-validation
  // gate, so block a host repointed at a private/metadata address before this
  // dashboard-origin fetch (mirrors runDatabricksStatement).
  const hostReason = validateDestinationUrl(`https://${host}`);
  if (hostReason) throw new Error(`workspace_host blocked: ${hostReason}`);

  // `volume` lives in the per-route binding, not config. Reading config.volume
  // produced an empty path segment whose 404 was swallowed as success, so the
  // flush deleted nothing while reporting success. Delete each bound volume; if
  // there are none, fail loudly rather than silently no-op.
  const volumes = await loadDestinationVolumeBindings(row.id);
  if (volumes.length === 0) throw new Error("databricks_volume_flush_no_bindings");

  for (const volume of volumes) {
    const volumePath = [
      "Volumes",
      String(config.catalog ?? ""),
      String(config.schema_name ?? ""),
      volume,
      ...prefix.split("/").filter(Boolean),
    ].map((segment) => encodeURIComponent(segment)).join("/");
    const url = `https://${host}/api/2.0/fs/directories/${volumePath}/`;
    const res = await safeDashboardFetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    if (!res.ok && res.status !== 404) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`databricks_volume_delete_${res.status}`);
    }
  }
  const scope = volumes.length === 1 ? "volume" : `${volumes.length} volumes`;
  return {
    destinationId: row.id,
    type: row.type,
    detail: prefix
      ? `Deleted Databricks volume directory ${prefix}/ across ${scope}.`
      : `Deleted all files under the configured Databricks ${scope}.`,
  };
}

async function runDatabricksStatement(row: DestinationRowWithBlob, statement: string): Promise<void> {
  const secrets = await decryptedSecrets(row);
  const token = secrets.access_token;
  const host = String(row.config.workspace_host ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const warehouseId = String(row.config.warehouse_id ?? "");
  if (!token) throw new Error("missing_access_token");
  if (!host) throw new Error("missing_workspace_host");
  if (!warehouseId) throw new Error("missing_warehouse_id");
  // SSRF guard at egress — workspace_host has no create/update url-validation
  // gate, so block a host repointed at a private/metadata address before this
  // dashboard-origin fetch.
  const hostReason = validateDestinationUrl(`https://${host}`);
  if (hostReason) throw new Error(`workspace_host blocked: ${hostReason}`);

  const res = await safeDashboardFetch(`https://${host}/api/2.0/sql/statements/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      warehouse_id: warehouseId,
      statement,
      wait_timeout: "30s",
      on_wait_timeout: "CANCEL",
    }),
    redirect: "manual",
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`databricks_http_${res.status}`);
  }
  const text = await res.text();
  if (!text.trim()) throw new Error("databricks_empty_statement_response");
  let parsed: { status?: { state?: string; error?: { message?: string } } };
  try {
    parsed = JSON.parse(text) as { status?: { state?: string; error?: { message?: string } } };
  } catch {
    throw new Error("databricks_invalid_json_response");
  }
  if (parsed.status?.state !== "SUCCEEDED") {
    throw new Error("databricks_statement_failed");
  }
}
