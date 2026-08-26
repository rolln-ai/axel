import "server-only";
import { createHash } from "node:crypto";
import { QUEUE_SPILL_KEY_PREFIX } from "@axel/shared";
import { clickhouse, hasClickhouseUrl, type ClickhouseQueryable } from "./clickhouse";
import { deleteR2Objects } from "./data-reset";
import { db, type Queryable } from "./db";
import type { ErasureMatch } from "./erasure-finder";

/**
 * GDPR erasure — executor (gated operator tool).
 *
 * Given the finder's matched event set, this BUILDS the per-store erasure plan
 * (event-id-scoped, reusing the data-reset.ts patterns) and — when
 * `ERASURE_EXECUTE_ENABLED=true` — executes it across ClickHouse, Postgres, and
 * R2. The flag defaults OFF: without it, executeErasure returns a dry-run with
 * ZERO mutations, so the destructive path can only run after a deliberate,
 * operator-set env flip. It is driven by the request lifecycle in
 * erasure-actions.ts (super-admin only), which records an audit row.
 *
 * The plan encodes the corrections the adversarial design review demanded:
 *  - ClickHouse mutations are partition-pruned by received_at bounds derived
 *    from the matched set (event_id is 4th in the ORDER BY, so an unbounded
 *    delete would rewrite every partition).
 *  - delivery_attempts / route_evaluations / the two ReplacingMergeTree rollups
 *    must match REPLAY-SUFFIXED ids (`{base}#rpy_…`), or replay rows survive.
 *  - All Postgres deletes are workspace-pinned and chunked.
 *  - R2: the ingest `events/` key is known from the index; queue-spill bodies
 *    (the one derived family that actually exists + holds PII) are reconstructed
 *    at execute time from delivery_attempts via the @axel/shared key shape.
 *  - Out-of-scope PII tables are disclosed, never silently skipped or
 *    over-deleted with a blind ILIKE.
 */

const CHUNK_SIZE = 1000;

// Destructive SQL is built with inline ids (the plan strings are asserted in
// tests + partition-prune ClickHouse), so before EXECUTING we re-validate every
// id matches the system-generated shape — a belt against any future data-model
// change letting an unexpected character reach an inline DELETE. Base ids plus
// an optional replay suffix `#rpy_…`.
const SAFE_EVENT_ID = /^[A-Za-z0-9_.:-]+(#rpy_[A-Za-z0-9_]+)?$/;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Escape RE2 metacharacters before interpolating an event id into a ClickHouse
 * `match()`. SAFE_EVENT_ID permits `.` (and `:`), which are RE2 metachars; today
 * uuidv7 ids contain none, but this removes the latent over-erasure hazard if the
 * id format ever changes.
 */
function escapeRe2(value: string): string {
  return value.replace(/[.^$|()[\]{}*+?\\]/g, "\\$&");
}

export interface ErasurePlanStatement {
  table: string;
  statement: string;
}

export interface ErasurePlan {
  eventIds: string[];
  receivedAtFrom: string | null;
  receivedAtTo: string | null;
  chunkSize: number;
  clickhouse: ErasurePlanStatement[];
  postgres: ErasurePlanStatement[];
  r2: { knownKeys: string[]; derivedAtExecute: string[] };
  outOfScope: Array<{ store: string; reason: string }>;
}

/** Per-store outcome, persisted into erasure_requests.store_results. */
export interface ErasureStoreResult {
  store: string;
  status: "deleted" | "skipped" | "out_of_scope" | "failed";
  count: number;
  detail?: string;
}

export interface ExecuteResult {
  dryRun: boolean;
  executeEnabled: boolean;
  mutationsIssued: number;
  plan: ErasurePlan;
  storeResults: ErasureStoreResult[];
  /** sha256 over the sorted (event_id, r2_key) set actually deleted; null on dry-run. */
  deletionManifestHash: string | null;
}

export interface ExecutorDeps {
  env?: Record<string, string | undefined>;
  /** Injectable for tests; defaults to the real ClickHouse/PG/R2 clients. */
  clickhouse?: ClickhouseQueryable;
  query?: Queryable;
  fetchImpl?: typeof fetch;
}

/** PURE: build the erasure plan from the matched set. Issues nothing. */
export function buildErasurePlan(workspaceId: string, matches: ErasureMatch[]): ErasurePlan {
  const eventIds = [...new Set(matches.map((m) => m.event_id))];
  const times = matches.map((m) => m.received_at).filter(Boolean).sort();
  const receivedAtFrom = times[0] ?? null;
  const receivedAtTo = times[times.length - 1] ?? null;
  const knownKeys = matches.map((m) => m.r2_key).filter((k): k is string => Boolean(k));

  const inList = (ids: string[]) => ids.map((id) => `'${id}'`).join(", ");
  const rpyMatch = (ids: string[]) =>
    ids.length === 0 ? "false" : `match(event_id, '^(${ids.map(escapeRe2).join("|")})#rpy_')`;

  // Date-based partition prune on each table's OWN partition column. We compare
  // toDate(col) — the literal PARTITION BY expression — to an unambiguous
  // YYYY-MM-DD literal (robust to pg's `timestamptz::text` format, unlike a raw
  // datetime literal with a tz offset). The bound is an OPTIMIZATION; the
  // event_id/workspace_id filter is what makes the delete correct, so a
  // malformed date safely degrades to no prune.
  const datePart = (ts: string | null): string | null => {
    const d = (ts ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  };
  const dateFrom = datePart(receivedAtFrom);
  const dateTo = datePart(receivedAtTo);
  // ±1-day safety margin. The bound is ANDed with event_id (which is what makes
  // the delete correct), so it must never EXCLUDE a targeted row. A day of slack
  // absorbs the only realistic boundary skew — an ingest↔delivery cross-clock
  // difference straddling UTC midnight (delivery_attempts.created_at is stamped
  // on a different worker than received_at) — while still pruning all but ±1
  // partition. (toDate('YYYY-MM-DD') - 1 is ClickHouse Date arithmetic.)
  const eventsDateBound =
    dateFrom && dateTo
      ? ` AND toDate(received_at) BETWEEN toDate('${dateFrom}') - 1 AND toDate('${dateTo}') + 1`
      : "";
  // delivery_attempts / route_evaluations occur AT or AFTER ingest, and can be
  // much later (retries, replays) — so LOWER-bound only, on their OWN time
  // column. An upper bound (receivedAtTo) would wrongly exclude later rows
  // (the original bug: it dropped delivery_attempts rows + their response_json
  // PII, and on single-event erasures matched nothing at all).
  const lowerBound = (col: string) => (dateFrom ? ` AND toDate(${col}) >= toDate('${dateFrom}') - 1` : "");

  const ch: ErasurePlanStatement[] = [];
  if (eventIds.length > 0) {
    // events: keyed on the base event_id only (replays don't add events rows).
    ch.push({
      table: "events",
      statement:
        `ALTER TABLE events DELETE WHERE workspace_id = '${workspaceId}'` +
        ` AND event_id IN (${inList(eventIds)})${eventsDateBound} SETTINGS mutations_sync = 1`,
    });
    // delivery_attempts + route_evaluations: base ids AND replay-suffixed ids.
    // Each table has a DIFFERENT time column — delivery_attempts.created_at vs
    // route_evaluations.evaluated_at — so they cannot share a bound expression.
    for (const { table, timeCol } of [
      { table: "delivery_attempts", timeCol: "created_at" },
      { table: "route_evaluations", timeCol: "evaluated_at" },
    ]) {
      ch.push({
        table,
        statement:
          `ALTER TABLE ${table} DELETE WHERE workspace_id = '${workspaceId}'` +
          ` AND (event_id IN (${inList(eventIds)}) OR ${rpyMatch(eventIds)})` +
          `${lowerBound(timeCol)} SETTINGS mutations_sync = 1`,
      });
    }
    // ReplacingMergeTree rollups don't retract on source delete — delete directly.
    ch.push({
      table: "delivery_latest_outcomes",
      statement:
        `ALTER TABLE delivery_latest_outcomes DELETE WHERE workspace_id = '${workspaceId}'` +
        ` AND (event_id IN (${inList(eventIds)}) OR ${rpyMatch(eventIds)}) SETTINGS mutations_sync = 1`,
    });
    ch.push({
      table: "delivery_base_latest_outcomes",
      statement:
        `ALTER TABLE delivery_base_latest_outcomes DELETE WHERE workspace_id = '${workspaceId}'` +
        ` AND base_event_id IN (${inList(eventIds)}) SETTINGS mutations_sync = 1`,
    });
  }

  const pg: ErasurePlanStatement[] = eventIds.length === 0 ? [] : [
    { table: "dead_letters", statement: "DELETE FROM dead_letters WHERE workspace_id = $1 AND event_id = ANY($2)" },
    // replay_requests.event_id stores the ORIGINAL (non-suffixed) event id — the
    // `rpy_` token is the row id, never appended to event_id — so a plain event_id
    // match is correct. (base_event_id is a ClickHouse-only computed alias; it does
    // not exist in Postgres, and referencing it here errored every execution.)
    { table: "replay_requests", statement: "DELETE FROM replay_requests WHERE workspace_id = $1 AND event_id = ANY($2)" },
    // delivery_idempotency stores the DELIVERED event_id, which is
    // replay-suffixed for replays (`{base}#rpy_…`) — match the base too.
    { table: "delivery_idempotency", statement: "DELETE FROM delivery_idempotency WHERE workspace_id = $1 AND (event_id = ANY($2) OR split_part(event_id, '#', 1) = ANY($2))" },
    // Prune the subject→event index itself — its rows carry the event_id + r2_key
    // storage-locator, so leaving them makes an erased subject still FINDABLE
    // (falsely reporting the data persists) and keeps a locator to a deleted
    // object (audit: erasure_subjects survived execution).
    { table: "erasure_subjects", statement: "DELETE FROM erasure_subjects WHERE workspace_id = $1 AND event_id = ANY($2)" },
  ];

  return {
    eventIds,
    receivedAtFrom,
    receivedAtTo,
    chunkSize: CHUNK_SIZE,
    clickhouse: ch,
    postgres: pg,
    r2: {
      knownKeys,
      derivedAtExecute: [
        // The only derived R2 family that actually exists in axel-events-raw:
        // queue-spill bodies carry {payload, headers, query}, so they hold PII.
        // Reconstructed at execute time from delivery_attempts (event_id,
        // destination_id, attempt_no) via the @axel/shared buildSpillKey shape.
        "queue-spill/{ws}/{event_id}/{destination_id}/{attempt_no}.json — reconstructed from delivery_attempts",
      ],
    },
    outOfScope: [
      { store: "postgres:event_map_fixtures / billing_events / notifications / dead_letter_mutes", reason: "no event_id linkage — out of automated scope" },
      { store: "clickhouse:events_daily", reason: "uniqExact aggregate — cannot surgically retract; expires at 30-day TTL" },
    ],
  };
}

/**
 * Build the plan and, when `ERASURE_EXECUTE_ENABLED=true`, execute it. The flag
 * defaults OFF → dry-run with zero mutations, so enabling destruction in prod is
 * a deliberate operator action. Order matters: queue-spill keys are
 * reconstructed from delivery_attempts BEFORE the ClickHouse delete removes
 * those rows; R2 is purged before ClickHouse/Postgres so a mid-run failure
 * leaves the locator data intact for a re-run rather than orphaning R2 objects.
 *
 * Each store is fault-isolated: a failure in one store is recorded against that
 * store (status `failed`) and the run CONTINUES, so one store's error never
 * blocks erasing the others and the audit trail always records what was + was
 * not deleted. The lifecycle inspects storeResults to mark the request
 * `failed` (any store failed) vs `partial`.
 */
export async function executeErasure(
  workspaceId: string,
  matches: ErasureMatch[],
  deps: ExecutorDeps = {},
): Promise<ExecuteResult> {
  const env = deps.env ?? process.env;
  const executeEnabled = env.ERASURE_EXECUTE_ENABLED === "true";
  const plan = buildErasurePlan(workspaceId, matches);

  if (!executeEnabled || plan.eventIds.length === 0) {
    return {
      dryRun: true,
      executeEnabled,
      mutationsIssued: 0,
      plan,
      storeResults: [],
      deletionManifestHash: null,
    };
  }

  // Re-validate every inline id before any destructive statement runs.
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) {
    throw new Error(`erasure_unsafe_workspace_id:${workspaceId}`);
  }
  for (const id of plan.eventIds) {
    if (!SAFE_EVENT_ID.test(id)) throw new Error(`erasure_unsafe_event_id:${id}`);
  }

  const storeResults: ErasureStoreResult[] = [];
  let mutationsIssued = 0;

  // 1) Reconstruct queue-spill keys from delivery_attempts BEFORE deleting them.
  // Best-effort: if it fails or ClickHouse is absent, we still purge events/ keys.
  // UNBOUNDED: the default client caps results at 10k rows (result_overflow_mode
  // =break), which would silently leave queue-spill PII un-erased for a
  // high-volume subject (>10k delivery attempts) while we report R2 "deleted".
  // The ALTER…DELETE mutations this client also runs return no rows, so dropping
  // the read cap is safe for them.
  const ch = deps.clickhouse ?? (hasClickhouseUrl() ? clickhouse({ unbounded: true }) : null);
  let spillKeys: string[] = [];
  if (ch) {
    try {
      spillKeys = await reconstructSpillKeys(ch, workspaceId, plan.eventIds);
    } catch (err) {
      storeResults.push({ store: "r2:queue-spill-locate", status: "failed", count: 0, detail: errMsg(err) });
    }
  }

  // 2) R2 first — knownKeys (raw ingest payloads) + reconstructed spill bodies.
  const r2Keys = [...new Set([...plan.r2.knownKeys, ...spillKeys])];
  try {
    const r2 = await deleteR2Objects(r2Keys, { env, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    storeResults.push(
      r2.skipped
        ? { store: "r2:axel-events-raw", status: "skipped", count: 0, detail: "CLOUDFLARE_API_TOKEN/ACCOUNT_ID not configured" }
        : { store: "r2:axel-events-raw", status: "deleted", count: r2.deleted, detail: `${plan.r2.knownKeys.length} events/ + ${spillKeys.length} queue-spill/` },
    );
    mutationsIssued += r2.deleted;
  } catch (err) {
    storeResults.push({ store: "r2:axel-events-raw", status: "failed", count: 0, detail: errMsg(err) });
  }

  // 3) ClickHouse — run each pre-built, partition-pruned mutation independently.
  for (const stmt of plan.clickhouse) {
    if (!ch) {
      storeResults.push({ store: `clickhouse:${stmt.table}`, status: "skipped", count: 0, detail: "CLICKHOUSE_URL not configured" });
      continue;
    }
    try {
      await ch.query(stmt.statement);
      storeResults.push({ store: `clickhouse:${stmt.table}`, status: "deleted", count: 1, detail: "mutation issued (mutations_sync=1)" });
      mutationsIssued += 1;
    } catch (err) {
      storeResults.push({ store: `clickhouse:${stmt.table}`, status: "failed", count: 0, detail: errMsg(err) });
    }
  }

  // 4) Postgres — workspace-pinned, chunked by event id. The subject→event index
  // (erasure_subjects) is held back and deleted LAST (below), only if every
  // destructive store completed cleanly.
  const q = deps.query ?? db();
  const runPgDelete = async (stmt: ErasurePlanStatement): Promise<void> => {
    try {
      let deleted = 0;
      for (let i = 0; i < plan.eventIds.length; i += CHUNK_SIZE) {
        const chunk = plan.eventIds.slice(i, i + CHUNK_SIZE);
        const res = await q.query(stmt.statement, [workspaceId, chunk]);
        deleted += res.rowCount ?? 0;
      }
      storeResults.push({ store: `postgres:${stmt.table}`, status: "deleted", count: deleted });
      mutationsIssued += deleted;
    } catch (err) {
      storeResults.push({ store: `postgres:${stmt.table}`, status: "failed", count: 0, detail: errMsg(err) });
    }
  };
  const indexStmt = plan.postgres.find((s) => s.table === "erasure_subjects");
  for (const stmt of plan.postgres) {
    if (stmt.table === "erasure_subjects") continue;
    await runPgDelete(stmt);
  }

  // 5) The locator index (erasure_subjects) is deleted only if EVERY destructive
  // store deleted cleanly. A failed/skipped store means un-erased PII remains, so
  // we retain the index to keep the erasure re-findable (retryable) instead of
  // orphaning the un-erased rows — which would then be permanently un-locatable.
  if (indexStmt) {
    const allClean = storeResults.every((r) => r.status === "deleted");
    if (allClean) {
      await runPgDelete(indexStmt);
    } else {
      storeResults.push({
        store: "postgres:erasure_subjects",
        status: "skipped",
        count: 0,
        detail: "index retained for retry — a destructive store did not complete",
      });
    }
  }

  // Disclose out-of-scope stores + the known spill-locate limitation (honest
  // audit): orphaned spill bodies from never-completed oversized deliveries can
  // outlive the delivery_attempts 30-day TTL we reconstruct keys from.
  for (const oos of plan.outOfScope) {
    storeResults.push({ store: oos.store, status: "out_of_scope", count: 0, detail: oos.reason });
  }
  storeResults.push({
    store: "r2:queue-spill (>30d, never-delivered)",
    status: "out_of_scope",
    count: 0,
    detail: "spill keys are reconstructed from delivery_attempts (30-day TTL); an orphaned spill from a never-completed oversized delivery older than that window may persist and need manual review",
  });

  return {
    dryRun: false,
    executeEnabled: true,
    mutationsIssued,
    plan,
    storeResults,
    deletionManifestHash: deletionManifestHash(matches),
  };
}

/**
 * Reconstruct the queue-spill R2 keys for the matched events. delivery_attempts
 * holds (event_id, destination_id, attempt_no) per attempt — including
 * replay-suffixed event_ids — which is exactly the tuple @axel/shared
 * buildSpillKey derives the key from.
 */
async function reconstructSpillKeys(
  ch: ClickhouseQueryable,
  workspaceId: string,
  eventIds: string[],
): Promise<string[]> {
  const inList = eventIds.map((id) => `'${id}'`).join(", ");
  const rpyMatch = `match(event_id, '^(${eventIds.map(escapeRe2).join("|")})#rpy_')`;
  const { rows } = await ch.query<{ event_id: string; destination_id: string; attempt_no: number | string }>(
    `SELECT DISTINCT event_id, destination_id, attempt_no
       FROM delivery_attempts
      WHERE workspace_id = {workspace_id:String}
        AND (event_id IN (${inList}) OR ${rpyMatch})`,
    { workspace_id: workspaceId },
  );
  return rows
    .filter((r) => r.destination_id)
    .map((r) => [QUEUE_SPILL_KEY_PREFIX, workspaceId, r.event_id, r.destination_id, `${r.attempt_no}.json`].join("/"));
}

/** sha256 over the sorted, de-duplicated (event_id, r2_key) set actually erased. */
function deletionManifestHash(matches: ErasureMatch[]): string {
  const pairs = [...new Set(matches.map((m) => `${m.event_id}\0${m.r2_key ?? ""}`))].sort();
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

/** Bounded, PII-free error detail for the per-store audit (never the raw value). */
function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
