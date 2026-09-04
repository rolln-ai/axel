/**
 * MongoDB pull connector (AXE-62).
 *
 * Each stream is either a `collection` (auto-built `find` with the
 * cursor predicate) or a `pipeline` (operator-provided aggregation,
 * JSON string, must contain a `$match` stage that references the
 * cursor column). Cursor pagination uses a monotonic field — by
 * default `_id` (ObjectId) — so big collections don't melt and
 * resumed syncs pick up where they left off.
 *
 * The connector itself doesn't depend on the `mongodb` driver:
 * callers pass a `connect` factory that builds a `MongoClientLike`.
 * The pull-worker wires the official `mongodb` driver; tests inject
 * a fake. Same shape as the AXE-61 Postgres connector.
 */

import type {
  PullConnector,
  PullCursor,
  PullCursorType,
  PullPage,
  PullReadInput,
  PullRecord,
  PullSchemaObject,
  PullSource,
  PullStream,
  PullStreamConfig,
} from "./types";

export interface MongodbConfig {
  /** Connection string (`mongodb://` or `mongodb+srv://`). Required. */
  uri: string;
  /** Database name to read from. Required. */
  database: string;
  /** Pagination cap per `read()` call. Default 500. */
  page_size?: number;
  streams?: PullStreamConfig[];
}

export type MongodbSource = PullSource<MongodbConfig>;

/**
 * Subset of the mongodb driver we depend on. Each stream holds a
 * collection or runs an aggregation; both return cursor-shaped
 * iterables we walk with `toArray()` after applying limit + sort.
 *
 * Kept narrow on purpose so tests can inject an in-memory fake
 * without dragging the mongodb npm package into this package.
 */
export interface MongodbCursorLike {
  toArray(): Promise<Record<string, unknown>[]>;
  sort(spec: Record<string, 1 | -1>): MongodbCursorLike;
  limit(n: number): MongodbCursorLike;
}

export interface MongodbCollectionLike {
  find(filter: Record<string, unknown>): MongodbCursorLike;
  aggregate(pipeline: Array<Record<string, unknown>>): MongodbCursorLike;
}

export interface MongodbDatabaseLike {
  collection(name: string): MongodbCollectionLike;
  /** AXE-64 — list collection names for the schema picker. */
  listCollections?(): Promise<Array<{ name: string; type?: string }>>;
}

export interface MongodbClientLike {
  db(name: string): MongodbDatabaseLike;
  close(): Promise<void>;
}

export interface MongodbConnect {
  (config: MongodbConfig): Promise<MongodbClientLike>;
}

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 5000;

export function createMongodbConnector(deps: {
  connect: MongodbConnect;
}): PullConnector<MongodbConfig> {
  // Per-source client cache — same lifecycle as the Postgres connector.
  const clientCache = new Map<string, Promise<MongodbClientLike>>();

  function getClient(source: MongodbSource): Promise<MongodbClientLike> {
    const cached = clientCache.get(source.source_id);
    if (cached) return cached;
    const fresh = deps.connect(source.config);
    clientCache.set(source.source_id, fresh);
    return fresh;
  }

  return {
    type: "mongodb",
    streams(config) {
      const declared = config.streams ?? [];
      return declared.map((stream) => new MongodbStream(stream, getClient));
    },
    async listSchemaObjects(config) {
      const client = await deps.connect(config);
      try {
        const db = client.db(config.database);
        if (!db.listCollections) {
          throw new Error("Mongo connect factory missing listCollections()");
        }
        const collections = (await db.listCollections()).slice(0, MONGO_DISCOVERY_MAX);
        // Per-collection sample to surface plausible cursor fields.
        // Bounded to MAX_SAMPLE so big clusters don't pay 500x findOne.
        const sampleLimit = Math.min(collections.length, MAX_SAMPLE);
        const samples = await Promise.all(
          collections.slice(0, sampleLimit).map(async (c) => {
            const rows = await db
              .collection(c.name)
              .find({})
              .limit(1)
              .toArray();
            return { name: c.name, sample: rows[0] ?? null };
          }),
        );
        const sampleByName = new Map<string, Record<string, unknown> | null>();
        for (const { name, sample } of samples) {
          sampleByName.set(name, sample);
        }
        return collections.map((c): PullSchemaObject => {
          const sample = sampleByName.get(c.name) ?? null;
          const candidates = sample ? cursorCandidatesFromSample(sample) : ["_id"];
          return {
            name: c.name,
            kind: "collection",
            cursor_candidates: candidates,
          };
        });
      } finally {
        try {
          await client.close();
        } catch {
          // Swallow close errors.
        }
      }
    },
    // Drain the per-source client cache. The pull-worker rebuilds the connector
    // registry every tick, so without this each sync run leaked its MongoClient
    // (and its connection pool) — exhausting the cluster's connection cap over
    // time. The caller invokes this in a finally after the sync run.
    async close() {
      const pending = [...clientCache.values()];
      clientCache.clear();
      await Promise.all(
        pending.map((p) =>
          p.then((c) => c.close()).catch(() => {
            // Swallow — a client that never connected (or already closed) is fine.
          }),
        ),
      );
    },
  };
}

const MONGO_DISCOVERY_MAX = 500;
const MAX_SAMPLE = 50;

function cursorCandidatesFromSample(sample: Record<string, unknown>): string[] {
  const out = new Set<string>(["_id"]);
  for (const [key, value] of Object.entries(sample)) {
    if (/_at$|_time$|^id$/i.test(key)) out.add(key);
    if (value instanceof Date) out.add(key);
  }
  return [...out];
}

class MongodbStream implements PullStream<MongodbConfig> {
  readonly defaultCursorField: string;

  constructor(
    private readonly config: PullStreamConfig,
    private readonly getClient: (source: MongodbSource) => Promise<MongodbClientLike>,
  ) {
    // ObjectId-as-cursor is the Mongo-native default — _id is monotonic
    // for inserts and uniformly indexed.
    this.defaultCursorField = config.cursor_column ?? "_id";
  }

  get name(): string {
    return this.config.name;
  }

  async read(input: PullReadInput<MongodbConfig>): Promise<PullPage> {
    const stream = input.stream;
    const cursorColumn = stream.cursor_column ?? this.defaultCursorField;
    const cursorType: PullCursorType = stream.cursor_type ?? "objectid";
    const pageSize = clamp(
      input.source.config.page_size ?? DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
    );
    const primaryKey = stream.primary_key ?? "_id";
    const lastCursor = input.state?.cursor ?? null;
    // Mirror the Postgres connector: within a tick the runner re-calls read()
    // with the prior page's nextCursor. Use it so we paginate PAST page 1 —
    // previously read() always used the static base cursor, so any collection
    // larger than page_size was silently truncated to its first page.
    const cursorValue = input.pageCursor ?? serialiseCursor(lastCursor, cursorType);

    const client = await this.getClient(input.source);
    const db = client.db(input.source.config.database);
    const rows = await runQuery({
      db,
      stream,
      cursorColumn,
      cursorValue,
      pageSize,
    });

    let highWatermark = lastCursor;
    const records: PullRecord[] = [];
    for (const row of rows) {
      const cursor = readCursor(row, cursorColumn, cursorType);
      highWatermark = maxCursor(highWatermark, cursor);
      const recordId = stringifyId(row[primaryKey]) ?? `${input.source.source_id}-${stream.name}-${records.length}`;
      records.push({
        source_id: input.source.source_id,
        workspace_id: input.source.workspace_id,
        source_type: "mongodb",
        stream: stream.name,
        record_id: recordId,
        cursor,
        extracted_at: input.now().toISOString(),
        data: row,
      });
    }

    // A full page implies more documents may follow — hand the runner a
    // nextCursor so it fetches the next page this tick. Short/empty page → done.
    const page: PullPage = { records, highWatermark };
    if (records.length === pageSize && highWatermark != null) {
      page.nextCursor = String(serialiseCursor(highWatermark, cursorType));
    }
    return page;
  }
}

async function runQuery(args: {
  db: MongodbDatabaseLike;
  stream: PullStreamConfig;
  cursorColumn: string;
  cursorValue: unknown;
  pageSize: number;
}): Promise<Record<string, unknown>[]> {
  const { db, stream, cursorColumn, cursorValue, pageSize } = args;
  if (stream.pipeline) {
    // Operator-provided aggregation pipeline (JSON string). Must
    // contain a `$match` that references the cursor column —
    // otherwise the operator will paginate the same page forever.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stream.pipeline);
    } catch (err: unknown) {
      throw new MongodbStreamError(
        "invalid_pipeline",
        `Pipeline for stream "${stream.name}" isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new MongodbStreamError(
        "invalid_pipeline",
        `Pipeline for stream "${stream.name}" must be a JSON array of stages.`,
      );
    }
    const pipelineRaw = parsed as Array<Record<string, unknown>>;
    if (!stream.collection) {
      throw new MongodbStreamError(
        "missing_collection",
        `Stream "${stream.name}" with a pipeline still needs a collection to run against.`,
      );
    }
    // Inject the incremental cursor predicate as a LEADING $match. Previously
    // the connector only checked the pipeline *mentioned* the cursor column but
    // never substituted the value, so each tick re-read from the start and
    // re-emitted every document (audit data-loss/dup). Auto-injection means the
    // operator no longer needs to reference the cursor themselves. Then append
    // sort + limit so a forgotten bound can't explode memory.
    const cursorStage = cursorValue === null
      ? []
      : [{ $match: { [cursorColumn]: { $gt: cursorValue } } }];
    const pipeline = [
      ...cursorStage,
      ...pipelineRaw,
      { $sort: { [cursorColumn]: 1 } },
      { $limit: pageSize },
    ];
    const collection = db.collection(stream.collection);
    return collection.aggregate(pipeline).toArray();
  }
  if (stream.collection) {
    const filter = cursorValue === null
      ? {}
      : { [cursorColumn]: { $gt: cursorValue } };
    const collection = db.collection(stream.collection);
    return collection
      .find(filter)
      .sort({ [cursorColumn]: 1 })
      .limit(pageSize)
      .toArray();
  }
  throw new MongodbStreamError(
    "missing_source",
    `Stream "${stream.name}" must declare either a collection or a pipeline.`,
  );
}

function serialiseCursor(cursor: PullCursor | null, type: PullCursorType): unknown {
  if (cursor === null || cursor.value === null) return null;
  const v = cursor.value;
  if (type === "integer") return typeof v === "number" ? v : Number(v);
  if (type === "string") return String(v);
  if (type === "timestamp") {
    if (typeof v === "number") return new Date(v);
    if (typeof v === "string") return new Date(v);
    return v;
  }
  // objectid: pass-through. The pull-worker's connect factory upgrades
  // string ObjectId hex to BSON ObjectId via the driver before query
  // submission — kept driver-free here.
  return v;
}

function readCursor(
  row: Record<string, unknown>,
  column: string,
  type: PullCursorType,
): PullCursor | null {
  const v = row[column];
  if (v === null || v === undefined) return null;
  if (type === "integer") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? { value: n } : null;
  }
  if (type === "timestamp") {
    if (v instanceof Date) return { value: v.toISOString() };
    return { value: String(v) };
  }
  // objectid + string: serialise via the canonical hex/string form.
  if (typeof v === "string" || typeof v === "number") return { value: v };
  return { value: String(v) };
}

function maxCursor(a: PullCursor | null, b: PullCursor | null): PullCursor | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.value === null) return b;
  if (b.value === null) return a;
  return (b.value as never) > (a.value as never) ? b : a;
}

function stringifyId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  // ObjectId or other BSON wrappers: prefer toString() if available so
  // we get the canonical 24-char hex.
  if (typeof (value as { toString?: () => string }).toString === "function") {
    const s = (value as { toString: () => string }).toString();
    if (typeof s === "string" && s.length > 0 && s !== "[object Object]") return s;
  }
  return null;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export class MongodbStreamError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
    this.name = "MongodbStreamError";
  }
}

/**
 * Standalone "ping the database" check for the dashboard's
 * test-connection action. Runs `db.command({ ping: 1 })` via the
 * configured collection() abstraction so we exercise auth + db
 * resolution without depending on a non-mock collection existing.
 */
export async function testMongodbConnection(
  config: MongodbConfig,
  deps: { connect: MongodbConnect },
): Promise<{ ok: true; latency_ms: number } | { ok: false; reason: string; message: string }> {
  let client: MongodbClientLike | null = null;
  const started = Date.now();
  try {
    client = await deps.connect(config);
    // Resolving the db handle + a no-op aggregation is enough to
    // exercise authentication on the server side without depending
    // on a specific collection existing.
    const db = client.db(config.database);
    await db.collection("__axel_ping").find({ _id: null }).limit(1).toArray();
    return { ok: true, latency_ms: Date.now() - started };
  } catch {
    return {
      ok: false,
      reason: "connection_failed",
      message: "connection_failed",
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // Swallow close errors.
      }
    }
  }
}
