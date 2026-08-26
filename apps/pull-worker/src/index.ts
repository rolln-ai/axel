import crypto from "node:crypto";
import pg from "pg";
import {
  createBigQueryConnector,
  createChargebeeConnector,
  createMongodbConnector,
  createPostgresConnector,
  createShopifyConnector,
  createStripeConnector,
  runPullSync,
  sanitizePullRunSummaryForStorage,
  type BigQueryClientLike,
  type BigQueryConfig,
  type BigQueryCredentials,
  type HttpFetch,
  type MongodbClientLike,
  type MongodbConfig,
  type PgClient,
  type PostgresConfig,
  type PullConnector,
  type PullRecord,
  type PullRecordSink,
  type PullRunSummary,
  type PullSource,
  type PullSourceState,
  type PullSourceType,
  type PullStateStore,
  type PullStreamState,
} from "@axel/pull-connectors";
import { BigQuery } from "@google-cloud/bigquery";
import { MongoClient, ObjectId } from "mongodb";
import { createSafePgStream, safeLookup } from "./safe-dns.js";
import { safePullHttpFetch } from "./safe-http.js";
import {
  decryptCredentialV2,
  extractEventTypeFromBody,
  parseHexMasterKey,
  pullPgSslOption,
  pullSourceCredentialAadString,
  sanitizeConnectorDiagnosticForStorage,
  shardFor,
  toArrayBuffer,
  tryAcquirePullSourceLock,
  type PullSourceLockClient,
  type QueueMessage,
} from "@axel/shared";
import { withPgRetry } from "@axel/observability";
import { logEventToClickhouse, type ClickhouseLogEnv } from "./clickhouse-log.js";

export interface PullSourceRow {
  id: string;
  workspace_id: string;
  name: string;
  type: PullSourceType;
  config: Record<string, unknown>;
  credentials_ref: string | null;
}

export interface CredentialRow {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  encryption_version: number;
  workspace_id: string;
  pull_source_id: string;
}

export interface RawPayloadStore {
  put(key: string, body: ArrayBuffer, metadata: Record<string, string>): Promise<void>;
}

export interface IngestQueueSink {
  enqueue(message: QueueMessage): Promise<void>;
}

export interface PullWorkerDeps {
  pool: pg.Pool;
  rawPayloads?: RawPayloadStore;
  ingestQueue?: IngestQueueSink;
  recordSink?: PullRecordSink;
  ingestUrl?: string;
  clickhouse?: ClickhouseLogEnv;
  connectors?: Map<PullSourceType, PullConnector<Record<string, unknown>>>;
  now?: () => Date;
}

export interface PullBatchFailure {
  sourceId: string;
  workspaceId: string;
  kind: "pre_run" | "stream";
  error: string;
}

/**
 * Raised only after every selected source has been attempted. This lets the
 * worker keep healthy sources moving while still failing the enclosing Sentry
 * check-in when any source genuinely failed.
 */
export class PullBatchError extends Error {
  constructor(
    readonly summaries: PullRunSummary[],
    readonly failures: PullBatchFailure[],
    readonly attempted: number,
  ) {
    const sourceIds = [...new Set(failures.map((failure) => failure.sourceId))];
    super(`pull batch had ${failures.length} failure(s) across ${sourceIds.length} source(s): ${sourceIds.join(", ")}`);
    this.name = "PullBatchError";
  }
}

export function defaultPullConnectorRegistry(
  credentialedFetch: HttpFetch = safePullHttpFetch,
): Map<PullSourceType, PullConnector<Record<string, unknown>>> {
  return new Map([
    ["chargebee", createChargebeeConnector(credentialedFetch) as unknown as PullConnector<Record<string, unknown>>],
    ["stripe", createStripeConnector(credentialedFetch) as unknown as PullConnector<Record<string, unknown>>],
    ["shopify", createShopifyConnector(credentialedFetch) as unknown as PullConnector<Record<string, unknown>>],
    [
      "postgres",
      createPostgresConnector({
        connect: createPgConnect(),
      }) as unknown as PullConnector<Record<string, unknown>>,
    ],
    [
      "mongodb",
      createMongodbConnector({
        connect: createMongoConnect(),
      }) as unknown as PullConnector<Record<string, unknown>>,
    ],
    [
      "bigquery",
      createBigQueryConnector({
        connect: createBigQueryConnect(),
      }) as unknown as PullConnector<Record<string, unknown>>,
    ],
  ]);
}

/**
 * Build a `MongoClient`-backed connect factory for the Mongo pull
 * connector. Cursor values that look like 24-char hex are upgraded to
 * `ObjectId` here so the `$gt` filter compares correctly server-side
 * (Mongo string > ObjectId mismatches silently produce empty pages).
 */
function createMongoConnect(): (config: MongodbConfig) => Promise<MongodbClientLike> {
  return async (config) => {
    const client = new MongoClient(config.uri, {
      // Keep the worker pool tight — each tick opens a fresh client and
      // closes it when the run finishes (close() is wired below).
      maxPoolSize: 4,
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      lookup: safeLookup,
    });
    await client.connect();
    return {
      db(name: string) {
        const db = client.db(name);
        return {
          collection(collectionName: string) {
            const coll = db.collection(collectionName);
            return {
              find(filter: Record<string, unknown>) {
                return wrapCursor(coll.find(rehydrateCursors(filter)));
              },
              aggregate(pipeline: Array<Record<string, unknown>>) {
                return wrapCursor(coll.aggregate(pipeline.map(rehydrateCursors)));
              },
            };
          },
          // AXE-64 — schema-discovery hook. Bounded server-side via
          // the connector (MAX_DISCOVERY).
          async listCollections() {
            const cursor = db.listCollections({}, { nameOnly: true });
            const docs = await cursor.toArray();
            return docs.map((d: { name: string; type?: string }) => ({
              name: d.name,
              ...(d.type ? { type: d.type } : {}),
            }));
          },
        };
      },
      async close() {
        await client.close();
      },
    };
  };
}

/**
 * Walk a filter / aggregation stage and upgrade any 24-char hex
 * string under a `$gt`/`$gte`/`$lt`/`$lte`/`$eq` to a real
 * `ObjectId`. Non-hex values pass through unchanged.
 *
 * Mongo's BSON comparison treats `ObjectId('…')` and the equivalent
 * 24-char string as different types — comparing across types yields
 * an empty result, not an error. This rehydration prevents that
 * silent failure mode for the `_id` cursor.
 */
function rehydrateCursors<T>(input: T): T {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map(rehydrateCursors) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      ["$gt", "$gte", "$lt", "$lte", "$eq"].includes(key) &&
      typeof value === "string" &&
      /^[0-9a-fA-F]{24}$/.test(value)
    ) {
      out[key] = new ObjectId(value);
    } else if (value !== null && typeof value === "object") {
      out[key] = rehydrateCursors(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

interface DriverCursor {
  toArray(): Promise<Record<string, unknown>[]>;
  sort(spec: Record<string, 1 | -1>): DriverCursor;
  limit(n: number): DriverCursor;
}

function wrapCursor(cursor: DriverCursor): {
  toArray(): Promise<Record<string, unknown>[]>;
  sort(spec: Record<string, 1 | -1>): ReturnType<typeof wrapCursor>;
  limit(n: number): ReturnType<typeof wrapCursor>;
} {
  return {
    toArray: () => cursor.toArray(),
    sort: (spec) => wrapCursor(cursor.sort(spec)),
    limit: (n) => wrapCursor(cursor.limit(n)),
  };
}

/**
 * Build a `BigQuery`-client-backed connect factory. Service-account
 * JSON is parsed inline (operator pasted it into the wizard); we do
 * NOT log it. Auth scope: BigQuery Data Viewer (read) is sufficient.
 */
function createBigQueryConnect(): (
  config: BigQueryConfig & Partial<BigQueryCredentials>,
) => Promise<BigQueryClientLike> {
  return async (config) => {
    if (!config.service_account_json) {
      throw new Error("BigQuery pull source missing service_account_json credential.");
    }
    const credentials = JSON.parse(config.service_account_json);
    const bq = new BigQuery({
      projectId: config.project_id,
      // The @google-cloud/bigquery types are very strict about credential
      // shape; cast through unknown rather than maintain a 12-field
      // mirror of the service-account JSON shape.
      credentials,
      ...(config.location ? { location: config.location } : {}),
    });
    return {
      async query({ sql, params, location, pageToken, maxResults }) {
        // BigQuery v8: bq.query returns [rows, query]. pagination via
        // pageToken needs createQueryJob + job.getQueryResults; for
        // MVP we rely on the per-tick page-size cap + cursor watermark
        // to advance across syncs and don't follow nextPageToken
        // within a single read() call.
        void pageToken;
        const [rows] = await bq.query({
          query: sql,
          params,
          ...(location ? { location } : {}),
          maxResults,
          useLegacySql: false,
        });
        return { rows: rows as Record<string, unknown>[] };
      },
    };
  };
}

/**
 * Build a `pg.Pool`-backed connect factory for the Postgres pull
 * connector. Each call creates a *new* short-lived pool so the
 * connector can `.end()` it cleanly between syncs — long-lived
 * pools against random user databases would hold connections open
 * even when there's no work to do.
 */
function createPgConnect(): (config: PostgresConfig) => Promise<PgClient> {
  return async (config) => {
    const pool = new pg.Pool({
      ...(config.connection_string
        ? { connectionString: config.connection_string }
        : {
            ...(config.host ? { host: config.host } : {}),
            ...(config.port ? { port: config.port } : {}),
            ...(config.database ? { database: config.database } : {}),
            ...(config.user ? { user: config.user } : {}),
            ...(config.password ? { password: config.password } : {}),
          }),
      stream: createSafePgStream,
      max: 2,
      // Verify the server certificate by default. A self-signed / private-CA DB
      // opts out with ssl:"no-verify" (or "disable" for no TLS).
      ssl: pullPgSslOption(config),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => {
      console.error("[pg-pull] async pool error:", safePullDiagnostic(err));
    });
    return {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
        // pg's generic constrains to QueryResultRow ({ [k]: any }); our
        // PgClient interface keeps it open so tests can pass strict types.
        // The cast on result.rows preserves the loose contract for
        // callers without weakening pg's runtime behaviour.
        const res = await pool.query(sql, params);
        return { rows: res.rows as T[] };
      },
      async end() {
        await pool.end();
      },
    };
  };
}

export async function runActivePullSources(
  deps: PullWorkerDeps,
  options: { limit?: number } = {},
): Promise<PullRunSummary[]> {
  const sources = await withPgRetry("list-active-pull-sources", () =>
    listActivePullSources(deps.pool, options.limit ?? 10),
  );
  const summaries: PullRunSummary[] = [];
  const failures: PullBatchFailure[] = [];
  for (const row of sources) {
    try {
      const summary = await runPullSource(deps, row);
      summaries.push(summary);
      const failedStreams = summary.streams.filter((stream) => stream.status === "failed");
      if (failedStreams.length > 0) {
        failures.push({
          sourceId: row.id,
          workspaceId: row.workspace_id,
          kind: "stream",
          error: failedStreams
            .map((stream) => `${stream.stream}: ${stream.error ?? "sync failed"}`)
            .join("; "),
        });
      }
    } catch (err) {
      // Another worker tick or a dashboard manual sync owns this source. This
      // is expected coordination, not an error worth logging every minute.
      if (err instanceof PullSourceSyncAlreadyRunningError) continue;
      // Resilience: a single source failing before/at sourceFromRow — e.g. an
      // orphaned `pull_source_credentials` row after a workspace delete (the
      // "pull credential row not found" Sentry issue), or an unregistered
      // connector — must NOT abort the whole tick and block every other
      // source's sync. Log and continue so the batch stays healthy; a source
      // whose workspace was deleted simply stops appearing on the next tick.
      console.error(
        `[pull-worker] skipping source ${row.id} (workspace ${row.workspace_id}): ` +
          safePullDiagnostic(err),
      );
      failures.push({
        sourceId: row.id,
        workspaceId: row.workspace_id,
        kind: "pre_run",
        error: safePullDiagnostic(err),
      });
    }
  }
  if (failures.length > 0) {
    throw new PullBatchError(summaries, failures, sources.length);
  }
  return summaries;
}

export async function runPullSource(
  deps: PullWorkerDeps,
  row: PullSourceRow,
): Promise<PullRunSummary> {
  const lease = await tryAcquirePullSourceLock(deps.pool, row.id);
  if (!lease) throw new PullSourceSyncAlreadyRunningError(row.id);
  try {
    return await runLockedPullSource(deps, row, lease.client);
  } finally {
    try {
      await lease.release();
    } catch (err) {
      // A broken PostgreSQL session releases its advisory locks server-side.
      // Do not turn an otherwise completed extraction into a failed run solely
      // because the explicit unlock could not be acknowledged.
      console.error(
        `[pull-worker] failed to release source lock ${row.id}: ${safePullDiagnostic(err)}`,
      );
    }
  }
}

class PullSourceSyncAlreadyRunningError extends Error {
  constructor(sourceId: string) {
    super(`pull source sync already running: ${sourceId}`);
    this.name = "PullSourceSyncAlreadyRunningError";
  }
}

async function runLockedPullSource(
  deps: PullWorkerDeps,
  row: PullSourceRow,
  database: PullSourceLockClient,
): Promise<PullRunSummary> {
  const runId = `psr_${crypto.randomUUID()}`;
  const now = deps.now ?? (() => new Date());
  // Claim the attempt immediately after the advisory lock. Credential loading
  // and connector construction can fail too; those attempts must still rotate
  // fairly and leave an auditable terminal pull_sync_runs row.
  await database.query(
    `INSERT INTO pull_sync_runs (id, pull_source_id, workspace_id, status, started_at)
     VALUES ($1, $2, $3, 'running', $4)`,
    [runId, row.id, row.workspace_id, now().toISOString()],
  );

  let connector: PullConnector<Record<string, unknown>> | undefined;
  try {
    const source = await sourceFromRow(database, row);
    connector = (deps.connectors ?? defaultPullConnectorRegistry()).get(source.type);
    if (!connector) throw new Error(`pull connector not registered: ${source.type}`);

    const summary = await runPullSync(
      {
        source,
        connector,
        stateStore: new PostgresPullStateStore(database),
        sink: deps.recordSink ?? defaultRecordSink(deps, source, now),
      },
      { now },
    );
    const failedStream = summary.streams.find((stream) => stream.status === "failed");
    const partialStream = summary.streams.find((stream) => stream.status === "partial");
    const runStatus = failedStream ? "failed" : partialStream ? "partial" : "success";
    await database.query(
      `UPDATE pull_sync_runs
          SET status = $2,
              finished_at = $3,
              records_emitted = $4,
              error_message = $5,
              summary = $6
        WHERE id = $1`,
      [
        runId,
        runStatus,
        now().toISOString(),
        summary.streams.reduce((sum, stream) => sum + stream.records, 0),
        failedStream?.error ?? partialStream?.error ?? null,
        JSON.stringify(sanitizePullRunSummaryForStorage(summary)),
      ],
    );
    return summary;
  } catch (err) {
    await database.query(
      `UPDATE pull_sync_runs
          SET status = 'failed',
              finished_at = $2,
              error_message = $3
        WHERE id = $1`,
      [runId, now().toISOString(), safePullDiagnostic(err)],
    );
    throw err;
  } finally {
    if (connector) {
      // Release any pooled clients the connector cached this run (e.g. mongodb's
      // MongoClient). Setup can fail before a connector exists, so the cleanup
      // path must tolerate an unbuilt connector.
      try {
        await connector.close?.();
      } catch (closeErr) {
        console.error(`[pull] connector close failed for ${row.id}: ${safePullDiagnostic(closeErr)}`);
      }
    }
  }
}

function defaultRecordSink(
  deps: PullWorkerDeps,
  source: PullSource<Record<string, unknown>>,
  now: () => Date,
): PullRecordSink {
  if (deps.rawPayloads && deps.ingestQueue) {
    return new AxelPipelinePullRecordSink({
      rawPayloads: deps.rawPayloads,
      ingestQueue: deps.ingestQueue,
      now,
      ...(deps.clickhouse ? { clickhouse: deps.clickhouse } : {}),
    });
  }
  return new HttpIngestPullRecordSink({
    ingestBaseUrl: deps.ingestUrl ?? "https://ingest.axelapp.ai",
    token: requireIngestToken(source),
  });
}

export class PostgresPullStateStore implements PullStateStore {
  constructor(private readonly pool: Pick<PullSourceLockClient, "query">) {}

  async get(sourceId: string): Promise<PullSourceState | null> {
    const result = await this.pool.query<{
      stream: string;
      cursor: unknown;
      resume_page_cursor: string | null;
      pending_high_watermark: unknown;
      updated_at: string;
    }>(
      `SELECT stream, cursor, resume_page_cursor, pending_high_watermark, updated_at::text
         FROM pull_source_stream_state
        WHERE pull_source_id = $1`,
      [sourceId],
    );
    if (result.rows.length === 0) return null;
    const streams: PullSourceState["streams"] = {};
    for (const row of result.rows) {
      streams[row.stream] = {
        cursor: isCursor(row.cursor) ? row.cursor : null,
        // Surface the persisted page token so the runner can resume an
        // interrupted pageset (null when no pageset is in flight).
        resumePageCursor: row.resume_page_cursor ?? null,
        pendingHighWatermark: isCursor(row.pending_high_watermark)
          ? row.pending_high_watermark
          : null,
        updated_at: row.updated_at,
      };
    }
    return { streams };
  }

  async setStreamState(sourceId: string, streamName: string, state: PullStreamState): Promise<void> {
    await this.pool.query(
      `INSERT INTO pull_source_stream_state
         (pull_source_id, stream, cursor, resume_page_cursor, pending_high_watermark, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pull_source_id, stream)
       DO UPDATE SET cursor = EXCLUDED.cursor,
                     resume_page_cursor = EXCLUDED.resume_page_cursor,
                     pending_high_watermark = EXCLUDED.pending_high_watermark,
                     updated_at = EXCLUDED.updated_at`,
      [
        sourceId,
        streamName,
        JSON.stringify(state.cursor),
        state.resumePageCursor ?? null,
        JSON.stringify(state.pendingHighWatermark ?? null),
        state.updated_at,
      ],
    );
  }
}

export class AxelPipelinePullRecordSink implements PullRecordSink {
  constructor(
    private readonly deps: {
      rawPayloads: RawPayloadStore;
      ingestQueue: IngestQueueSink;
      clickhouse?: ClickhouseLogEnv;
      now: () => Date;
    },
  ) {}

  async write(record: PullRecord): Promise<void> {
    const body = JSON.stringify(record);
    const bytes = new TextEncoder().encode(body);
    const eventId = [
      "pull",
      record.source_type,
      record.stream,
      stablePart(record.record_id),
      stablePart(String(record.cursor?.value ?? "none")),
    ].join("_");
    const receivedAt = this.deps.now().toISOString();
    const r2Key = `pull/${record.workspace_id}/${record.source_id}/${record.stream}/${eventId}.json`;
    await this.deps.rawPayloads.put(r2Key, toArrayBuffer(bytes), {
      event_id: eventId,
      workspace_id: record.workspace_id,
      source_id: record.source_id,
      pull_stream: record.stream,
    });
    const shard = shardFor(eventId);
    const eventType = extractEventTypeFromBody(bytes);
    const message: QueueMessage = {
      event_id: eventId,
      workspace_id: record.workspace_id,
      source_id: record.source_id,
      r2_key: r2Key,
      received_at: receivedAt,
      content_type: "application/json",
      size_bytes: bytes.byteLength,
      shard,
      headers: {
        "x-axel-pull-source-type": record.source_type,
        "x-axel-pull-stream": record.stream,
      },
      query: {},
      // Pull-source records are real production events from the customer's
      // SaaS account, not test traffic.
      is_test: false,
      ...(eventType ? { event_type: eventType } : {}),
    };
    await this.deps.ingestQueue.enqueue(message);
    if (this.deps.clickhouse) {
      await logEventToClickhouse(this.deps.clickhouse, message);
    }
  }
}

export class HttpIngestPullRecordSink implements PullRecordSink {
  constructor(
    private readonly deps: {
      ingestBaseUrl: string;
      token: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async write(record: PullRecord): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const url = `${this.deps.ingestBaseUrl.replace(/\/$/, "")}/in/${encodeURIComponent(record.source_id)}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-axel-token": this.deps.token,
        "x-axel-pull-source-type": record.source_type,
        "x-axel-pull-stream": record.stream,
      },
      body: JSON.stringify(record),
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`ingest accepted no pull record: HTTP ${response.status}`);
    }
  }
}

async function listActivePullSources(pool: pg.Pool, limit: number): Promise<PullSourceRow[]> {
  const result = await pool.query<PullSourceRow>(
      `SELECT ps.id, ps.workspace_id, ps.name, ps.type, ps.config, ps.credentials_ref
       FROM pull_sources ps
       JOIN sources ingest_source
         ON ingest_source.id = ps.id
        AND ingest_source.workspace_id = ps.workspace_id
        AND ingest_source.status = 'active'
      WHERE ps.status = 'active'
        AND NOT EXISTS (
          SELECT 1
            FROM pull_sync_runs r
           WHERE r.pull_source_id = ps.id
             AND r.status = 'running'
             AND r.started_at > now() - interval '30 minutes'
        )
      ORDER BY (
        SELECT MAX(history.started_at)
          FROM pull_sync_runs history
         WHERE history.pull_source_id = ps.id
      ) ASC NULLS FIRST,
      ps.updated_at ASC,
      ps.id ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function sourceFromRow(pool: Pick<PullSourceLockClient, "query">, row: PullSourceRow): Promise<PullSource<Record<string, unknown>>> {
  const credentials = await fetchCredentials(
    pool,
    row.credentials_ref,
    row.workspace_id,
    row.id,
  );
  return {
    source_id: row.id,
    workspace_id: row.workspace_id,
    type: row.type,
    name: row.name,
    config: { ...row.config, ...credentials },
    credentials_ref: row.credentials_ref,
  };
}

async function fetchCredentials(
  pool: Pick<PullSourceLockClient, "query">,
  credentialsRef: string | null,
  workspaceId: string,
  pullSourceId: string,
): Promise<Record<string, unknown>> {
  if (!credentialsRef) return {};
  const key = loadMasterKey();
  const result = await pool.query<CredentialRow>(
    `SELECT ciphertext, nonce, auth_tag, encryption_version, workspace_id, pull_source_id
       FROM pull_source_credentials
      WHERE id = $1
        AND workspace_id = $2
        AND pull_source_id = $3
      LIMIT 1`,
    [credentialsRef, workspaceId, pullSourceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("pull credential row not found");
  const plaintext = await decryptCredentialBlob(key, row, workspaceId, pullSourceId);
  return JSON.parse(plaintext) as Record<string, unknown>;
}

/**
 * Decrypt a pull_source_credentials row via the shared AES-256-GCM core
 * (@axel/shared credential-crypto — golden-vector pinned). The v2 AAD is
 * rebuilt from the parent pull source identity supplied by the scoped lookup;
 * direct callers default to the row identity for backwards compatibility.
 */
export function decryptCredentialBlob(
  key: Buffer,
  row: CredentialRow,
  workspaceId = row.workspace_id,
  pullSourceId = row.pull_source_id,
): Promise<string> {
  return decryptCredentialV2(row, key, pullSourceCredentialAadString(workspaceId, pullSourceId));
}

function loadMasterKey(): Buffer {
  const hex = process.env.CREDENTIALS_MASTER_KEY;
  if (!hex) throw new Error("CREDENTIALS_MASTER_KEY must be set to 64 hex characters");
  // Strict 64-hex acceptance, unchanged — shared parse throws the same way.
  return Buffer.from(parseHexMasterKey(hex));
}

function isCursor(value: unknown): value is PullStreamState["cursor"] {
  return value === null
    || !!value
      && typeof value === "object"
      && ("value" in value)
      && (
        typeof (value as { value?: unknown }).value === "string"
        || typeof (value as { value?: unknown }).value === "number"
        || (value as { value?: unknown }).value === null
      );
}

function stablePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160);
}

function requireIngestToken(source: PullSource<Record<string, unknown>>): string {
  const token = source.config.ingest_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("pull source credential is missing ingest_token");
  }
  return token;
}

function safePullDiagnostic(value: unknown): string {
  return sanitizeConnectorDiagnosticForStorage(
    value instanceof Error ? value.message : value,
    500,
  ) || "pull_sync_failed";
}
