import pg from "pg";
import type { Connector, DeliveryContext } from "@axel/connectors";
import {
  connectionHostSsrfReason,
  mapInfoSchemaType,
  planColumnRepair,
  planDottedColumnInsert,
  quotePgIdent,
  quotePgTable,
  sanitizeConnectorDiagnosticForStorage,
  splitPgTable,
  type Destination,
  type DeliveryAttempt,
  type PgLeafType,
  type PostgresBinding,
  type RouteDestinationBinding,
} from "@axel/shared";
import { createSafePgStream } from "../safe-dns.js";

/**
 * Postgres destination connector.
 *
 * Two paths for choosing the write target:
 *
 *   1. Route-level binding (preferred, AXE-binding) — the route carries
 *      `{ table, mode, payload_column? }` on `route_destinations.binding`
 *      and the router copies it onto the queue message. One destination
 *      can fan out to many tables via separate routes.
 *
 *   2. Legacy fallback — pre-binding rows used `destinations.config.table`
 *      and `destinations.config.payload_column`. Bindings backfilled by
 *      migration 0022 cover all existing rows; the fallback is just for
 *      defense in depth on a race during deploys.
 *
 * Modes (binding.mode):
 *
 *   - `jsonb_blob` — INSERT one row with the entire payload in a single
 *      jsonb column (defaults to "payload"). The customer creates the
 *      table once; Axel never alters it. This is the original behavior.
 *
 *   - `dotted_columns` — flatten the payload with dot-notation keys
 *      and infer columns. Nested `{user: {email: ...}}` becomes
 *      column `"user.email"`. Each delivery checks the live column set
 *      and adds new leaves only with schema_evolution: add_columns.
 *      Existing types are never widened automatically. Type inference: number → numeric, boolean → boolean,
 *      string → text, nested object/array → jsonb. Null leaves are
 *      skipped (column stays nullable / unwritten).
 *
 * Pooling: one Pool per (connection_string).
 */

interface PostgresDestinationConfig {
  connection_string: string;
  /** Legacy / default — used when binding is missing. */
  table?: string;
  /** Legacy / default — used when binding is missing. */
  payload_column?: string;
  /** Legacy mapped-column mode (kept; not yet route-bindable). */
  columns?: Record<string, string>;
  /** If set, ON CONFLICT (idempotency_column) DO NOTHING. */
  idempotency_column?: string;
}

const pools = new Map<string, pg.Pool>();

function getPool(connectionString: string): pg.Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      stream: createSafePgStream,
      max: 16,
      // Verify the server cert by default (was rejectUnauthorized:false, which
      // accepted ANY cert → MITM on shared infra). A customer DB with a private/
      // self-signed cert must opt out explicitly via `?sslmode=no-verify` in its
      // connection string rather than us silently disabling verification for all.
      ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: true },
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    });
    pool.on("error", (err) => {
      console.error(
        `[postgres-connector] pool error: ${sanitizeConnectorDiagnosticForStorage(
          err instanceof Error ? err.message : err,
        )}`,
      );
    });
    pools.set(connectionString, pool);
  }
  return pool;
}

const TRANSIENT_PG_PATTERNS = [
  /connection terminated/i,
  /connection ended/i,
  /econnreset/i,
  /server closed/i,
  /timeout exceeded when trying to connect/i,
];

function attemptOf(
  context: DeliveryContext | undefined,
  destination: Destination,
  status: DeliveryAttempt["status"],
  response: unknown,
  startedAt: number,
): DeliveryAttempt {
  return {
    attempt_id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    event_id: context?.eventId ?? "unknown",
    destination_id: destination.destination_id,
    status,
    response,
    latency_ms: Date.now() - startedAt,
    created_at: new Date().toISOString(),
  };
}

function pickValue(payload: unknown, path: string): unknown {
  if (path === "$") return payload;
  if (!path.startsWith("$.")) return path; // literal
  const segments = path.slice(2).split(".");
  let current: unknown = payload;
  for (const seg of segments) {
    if (current && typeof current === "object" && seg in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return current;
}

/**
 * Pull the effective Postgres binding from either the route-level
 * binding (preferred) or the destination's config (legacy fallback).
 * Returns null if neither yields a usable table — connector will
 * dead-letter the attempt rather than write to "no table".
 */
function resolveBinding(
  binding: RouteDestinationBinding | null | undefined,
  config: PostgresDestinationConfig,
): PostgresBinding | null {
  if (binding && typeof binding === "object" && "table" in binding && typeof binding.table === "string") {
    return binding as PostgresBinding;
  }
  if (config.table) {
    return {
      table: config.table,
      mode: "jsonb_blob",
      ...(config.payload_column !== undefined ? { payload_column: config.payload_column } : {}),
    };
  }
  return null;
}

export function createPostgresConnector(): Connector<PostgresDestinationConfig> {
  return {
    type: "postgres",
    async deliver(event, destination, context) {
      const startedAt = Date.now();
      const config = destination.config;

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(event));
      } catch {
        payload = new TextDecoder().decode(event);
      }

      const binding = resolveBinding(context?.binding, config);
      if (!binding) {
        return attemptOf(
          context,
          destination,
          "dead",
          { error: "no table binding configured for this route/destination" },
          startedAt,
        );
      }

      // Delivery-time SSRF guard (every other connector re-checks): block a
      // connection_string pointing at loopback/private/metadata hosts before
      // opening a socket. Permanent → dead-letter.
      const pgSsrf = connectionHostSsrfReason(config.connection_string);
      if (pgSsrf) {
        return attemptOf(context, destination, "dead", { error: `ssrf_blocked: ${pgSsrf}` }, startedAt);
      }
      const pool = getPool(config.connection_string);

      const runQuery = async () => {
        if (binding.mode === "dotted_columns") {
          // flattenPayloadToColumns wraps non-object payloads as { value: … },
          // sanitizes keys, remaps reserved id/received_at, spills overflow to
          // _extra. Schema additions need explicit permission; type changes
          // are rejected before ALTER or INSERT.
          await insertDottedColumns(pool, binding.table, payload, binding.schema_evolution === "add_columns");
          return;
        }
        // jsonb_blob mode (default) — or legacy column-mapping if config.columns is set.
        if (config.columns && Object.keys(config.columns).length > 0) {
          const cols = Object.keys(config.columns);
          const vals = cols.map((c) => pickValue(payload, config.columns![c]!));
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
          const conflict = config.idempotency_column
            ? `ON CONFLICT (${quotePgIdent(config.idempotency_column)}) DO NOTHING`
            : "";
          const sql = `INSERT INTO ${quotePgTable(binding.table)} (${cols.map(quotePgIdent).join(", ")}) VALUES (${placeholders}) ${conflict}`;
          const safeVals = vals.map((v) => {
            if (v && typeof v === "object") return JSON.stringify(v);
            return v;
          });
          await pool.query(sql, safeVals);
          return;
        }
        const col = binding.payload_column ?? "payload";
        const sql = `INSERT INTO ${quotePgTable(binding.table)} (${quotePgIdent(col)}) VALUES ($1::jsonb)`;
        await pool.query(sql, [JSON.stringify(payload)]);
      };

      try {
        try {
          await runQuery();
        } catch (firstErr) {
          const message = firstErr instanceof Error ? firstErr.message : String(firstErr);
          if (TRANSIENT_PG_PATTERNS.some((re) => re.test(message))) {
            console.warn(
              `[postgres-connector] transient on insert: retrying once: ${sanitizeConnectorDiagnosticForStorage(message, 200)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            await runQuery();
          } else {
            throw firstErr;
          }
        }
        return attemptOf(
          context,
          destination,
          "success",
          { table: binding.table, mode: binding.mode },
          startedAt,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Classify on the SQLSTATE code (authoritative) AS WELL AS the message:
        // 28=auth, 42=syntax/undefined/insufficient-privilege, 23=integrity,
        // 22=data exception, 3D/3F=invalid db/schema → all PERMANENT (retrying
        // can't fix bad credentials, a missing table, or a constraint violation),
        // so dead-letter immediately instead of burning the whole retry budget.
        const code = (err as { code?: unknown }).code;
        const permanentCode = code === "AXEL_SCHEMA_CHANGE_REQUIRED"
          || (typeof code === "string" && /^(22|23|28|42|3D|3F)/.test(code));
        const retryable =
          !permanentCode &&
          !/(violates|duplicate key|undefined column|invalid input|requires a JSON object|unsafe.{0,12}identifier)/i.test(message);
        return attemptOf(
          context,
          destination,
          retryable ? "retry" : "dead",
          { error: message.slice(0, 500) },
          startedAt,
        );
      }
    },
  };
}

/**
 * Dotted-columns insert: flatten nested keys with dot-notation,
 * add missing columns only when explicitly allowed, then INSERT.
 *
 * Two round trips per insert under steady state:
 *   1. SELECT existing columns from information_schema
 *   2. INSERT (possibly preceded by ALTER TABLE ADD COLUMN for new keys)
 *
 * For volume workloads this becomes the bottleneck; an in-process
 * column cache keyed by (connection_string, table) keeps the schema
 * read off the hot path.
 */
const columnCache = new Map<string, Map<string, PgLeafType>>();
const tableInitCache = new Set<string>();

function requireSchemaReview(): never {
  throw Object.assign(new Error("Incoming fields require a Postgres schema change. The table was left unchanged. Review downstream queries, update the schema and replay. Enable add_columns only for reviewed additions; existing column types are never changed automatically."), {
    code: "AXEL_SCHEMA_CHANGE_REQUIRED",
  });
}

async function insertDottedColumns(
  pool: pg.Pool,
  table: string,
  payload: unknown,
  allowAdditions: boolean,
): Promise<void> {
  const tableKey = `${pool.options.connectionString ?? ""}::${table}`;

  // Create missing tables with the first row's complete schema. IF NOT EXISTS
  // leaves pre-existing or concurrently created tables unchanged.
  if (!tableInitCache.has(tableKey)) {
    const initial = planDottedColumnInsert(table, payload, new Map());
    const columns = initial?.adds.map((field) => `${quotePgIdent(field.name)} ${field.type}`) ?? [];
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${quotePgTable(table)} (
         id bigserial PRIMARY KEY,
         received_at timestamptz NOT NULL DEFAULT now()
         ${columns.length ? `, ${columns.join(", ")}` : ""}
       )`,
    );
    tableInitCache.add(tableKey);
  }

  let colTypes = columnCache.get(tableKey);
  if (!colTypes) {
    colTypes = await readColumnTypes(pool, table);
    columnCache.set(tableKey, colTypes);
  }

  // The add/widen/ALTER/INSERT planning is the shared pure planner
  // (@axel/shared pg-columns), identical to the delivery-edge connector; this
  // side keeps only node-pg execution and the schema cache. jsonb params are
  // "stringified": node-pg needs an explicit JSON string with the $n::jsonb
  // cast (it does not reliably encode a plain object to jsonb otherwise).
  const plan = planDottedColumnInsert(table, payload, colTypes);
  if (!plan) return; // empty payload — nothing to insert

  // Check the entire plan before any ALTER. A field addition cannot authorize
  // changing a different field's type, which could rewrite data or break views.
  if (plan.widens.length > 0 || (plan.adds.length > 0 && !allowAdditions)) requireSchemaReview();

  if (plan.addColumnsSql) {
    await pool.query(plan.addColumnsSql);
    for (const a of plan.adds) colTypes.set(a.name, a.type);
  }

  try {
    await pool.query(plan.insertSql, plan.insertParams);
  } catch (err) {
    // Stale cache (column dropped/renamed externally) → refresh once and retry.
    if ((err as { code?: string })?.code === "42703") {
      columnCache.delete(tableKey);
      const fresh = await readColumnTypes(pool, table);
      columnCache.set(tableKey, fresh);
      const repair = planColumnRepair(table, plan, fresh);
      if (repair.added.length > 0 && !allowAdditions) requireSchemaReview();
      if (repair.addColumnsSql) {
        await pool.query(repair.addColumnsSql);
        for (const a of repair.added) fresh.set(a.name, a.type);
      }
      await pool.query(plan.insertSql, plan.insertParams);
    } else {
      throw err;
    }
  }
}

async function readColumnTypes(pool: pg.Pool, table: string): Promise<Map<string, PgLeafType>> {
  // Filter on the real (schema, table) pair for a qualified target — "app.events"
  // as a bare table_name never matches. A bare name keeps the search_path lookup.
  const { schema, table: tableName } = splitPgTable(table);
  const result = table.includes(".")
    ? await pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_name = $1 AND table_schema = $2`,
        [tableName, schema],
      )
    : await pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_name = $1
            AND table_schema = ANY(current_schemas(false))`,
        [table],
      );
  const m = new Map<string, PgLeafType>();
  // mapInfoSchemaType moved verbatim to @axel/shared/pg-columns so both
  // drivers classify live columns identically.
  for (const r of result.rows) m.set(r.column_name, mapInfoSchemaType(r.data_type));
  return m;
}

/** Test-only: drain all pools so tests don't keep open handles. */
export async function closeAllPostgresPools(): Promise<void> {
  for (const pool of pools.values()) await pool.end();
  pools.clear();
  columnCache.clear();
  tableInitCache.clear();
}
