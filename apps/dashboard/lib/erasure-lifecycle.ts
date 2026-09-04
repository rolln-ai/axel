import "server-only";
import { createHash } from "node:crypto";
import { db, type Queryable } from "./db";
import { findSubjectEvents, type FindResult } from "./erasure-finder";
import { executeErasure, type ExecuteResult } from "./erasure-executor";
import type { SubjectIdentifier } from "./erasure-subject-id";
import { prefixedId } from "./ids";

/**
 * GDPR erasure — request lifecycle (orchestration core).
 *
 * Runs one per-subject erasure request end to end and writes the
 * `erasure_requests` audit row through its state machine
 * (received → finding → found → erasing → done|partial|failed). The audit row
 * OUTLIVES the erased data and never holds plaintext PII — only hashed
 * subject_ids + a raw-identifier fingerprint.
 *
 * Not a server action (no auth here) — the super-admin gate lives in the
 * `runErasureAction` wrapper in erasure-actions.ts. Kept separate so this
 * orchestration + its types/helpers stay importable from non-action code and
 * unit-testable with injected deps.
 *
 * Two safety properties beyond the executor's own ERASURE_EXECUTE_ENABLED gate:
 *  - Cardinality guard: a subject matching more than ERASURE_MAX_EVENTS events
 *    (default 50k) is treated as a likely shared value (family email, org id —
 *    see erasure-subject-id §9.3) and is NOT erased without explicit confirm.
 *  - The finder never claims `full_within_window`, so a successful erase lands
 *    in `partial`, never `done` — we erase what we located, we don't claim it
 *    was everything.
 */

const DEFAULT_MAX_EVENTS = 50_000;

export interface ProcessErasureOptions {
  /** Operator override to erase a large (likely shared-value) match set. */
  confirmLargeSet?: boolean;
  /** Threshold above which the cardinality guard trips. */
  maxEvents?: number;
}

export interface ProcessErasureResult {
  requestId: string;
  state: "found" | "partial" | "failed" | "blocked_large_set";
  matchedEventCount: number;
  coverage: FindResult["coverage"];
  executed: boolean;
  storeResults: ExecuteResult["storeResults"];
  deletionManifestHash: string | null;
  error?: string;
}

export interface ProcessErasureDeps {
  query?: Queryable;
  find?: typeof findSubjectEvents;
  execute?: typeof executeErasure;
  env?: Record<string, string | undefined>;
  newId?: () => string;
}

export async function processErasureRequest(
  workspaceId: string,
  identifiers: SubjectIdentifier[],
  requestedByUserId: string | null,
  opts: ProcessErasureOptions = {},
  deps: ProcessErasureDeps = {},
): Promise<ProcessErasureResult> {
  const q = deps.query ?? db();
  const find = deps.find ?? findSubjectEvents;
  const execute = deps.execute ?? executeErasure;
  const env = deps.env ?? process.env;
  const requestId = (deps.newId ?? (() => prefixedId("ers")))();
  // Fail CLOSED: a missing or non-numeric ERASURE_MAX_EVENTS must not disable the
  // cardinality guard (a NaN comparison is always false → guard never trips).
  const envMax = Number(env.ERASURE_MAX_EVENTS);
  const maxEvents = opts.maxEvents ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_EVENTS);

  // Fingerprint the operator input for dedup/audit — never store raw PII.
  const rawFingerprint = createHash("sha256")
    .update(identifiers.map((i) => `${i.kind} ${i.value}`).sort().join(""))
    .digest("hex");

  await q.query(
    `INSERT INTO erasure_requests (id, workspace_id, subject_ids, raw_identifier_fingerprint, state, requested_by_user_id)
     VALUES ($1, $2, $3, $4, 'finding', $5)`,
    [requestId, workspaceId, [], rawFingerprint, requestedByUserId],
  );

  let found: FindResult;
  try {
    found = await find(workspaceId, identifiers, {});
  } catch {
    const errorCode = "erasure_find_failed";
    await failRequest(q, requestId, errorCode);
    return blank(requestId, "failed", errorCode);
  }

  const matchedEventCount = found.matches.length;

  // Cardinality guard — refuse a likely shared-value mass erasure without an
  // explicit operator override. Persist as `found` (located, not erased).
  if (matchedEventCount > maxEvents && !opts.confirmLargeSet) {
    await q.query(
      `UPDATE erasure_requests
          SET state = 'found', subject_ids = $2, coverage = $3, index_window_from = $4,
              matched_event_count = $5, uncovered_disclosure = $6,
              error_message = $7, finished_at = now()
        WHERE id = $1`,
      [
        requestId,
        found.subjectIds,
        found.coverage,
        found.indexWindowFrom,
        matchedEventCount,
        JSON.stringify(found.uncovered),
        `cardinality_guard: ${matchedEventCount} > ${maxEvents} — likely shared value; re-run with confirmLargeSet`,
      ],
    );
    return {
      requestId,
      state: "blocked_large_set",
      matchedEventCount,
      coverage: found.coverage,
      executed: false,
      storeResults: [],
      deletionManifestHash: null,
      error: `Matched ${matchedEventCount} events (> ${maxEvents}). Likely a shared value — confirm to proceed.`,
    };
  }

  await q.query(
    `UPDATE erasure_requests
        SET state = 'erasing', subject_ids = $2, coverage = $3, index_window_from = $4,
            matched_event_count = $5, uncovered_disclosure = $6
      WHERE id = $1`,
    [requestId, found.subjectIds, found.coverage, found.indexWindowFrom, matchedEventCount, JSON.stringify(found.uncovered)],
  );

  let result: ExecuteResult;
  try {
    result = await execute(workspaceId, found.matches, deps.env ? { env: deps.env } : {});
  } catch {
    const errorCode = "erasure_execute_failed";
    await failRequest(q, requestId, errorCode);
    return blank(requestId, "failed", errorCode, matchedEventCount, found.coverage);
  }

  const auditStoreResults = sanitizeErasureStoreResults(result.storeResults);

  // Terminal state. Gate off → `found` (located only, nothing erased). If any
  // store failed, the erasure is incomplete → `failed`, but we STILL persist the
  // store_results + manifest so the audit records exactly what WAS deleted (a
  // bare 'failed' with no detail would lose that record). Otherwise `partial`
  // (the finder never claims completeness, so never `done`).
  // A SKIPPED destructive store (e.g. R2 with no CLOUDFLARE_R2_API_TOKEN) means PII
  // was NOT erased — treat it as a failure, not silently as 'partial' (audit: a
  // skipped R2 store masked un-erased raw payloads). out_of_scope is legitimately
  // not-in-scope, so it is NOT counted as incomplete.
  const incompleteStores = auditStoreResults.filter(
    (s) => s.status === "failed" || s.status === "skipped",
  );
  const terminal: "found" | "partial" | "failed" = result.dryRun
    ? "found"
    : incompleteStores.length > 0
      ? "failed"
      : "partial";
  const errorMessage = result.dryRun
    ? "execution_disabled: ERASURE_EXECUTE_ENABLED is not 'true' — located only, nothing erased"
    : incompleteStores.length > 0
      ? `incomplete_erasure: ${incompleteStores.map((s) => `${s.store}=${s.status}`).join(", ")} — see store_results`
      : null;
  await q.query(
    `UPDATE erasure_requests
        SET state = $2, store_results = $3, deletion_manifest_hash = $4,
            error_message = $5, finished_at = now()
      WHERE id = $1`,
    [requestId, terminal, JSON.stringify(auditStoreResults), result.deletionManifestHash, errorMessage],
  );

  return {
    requestId,
    state: terminal,
    matchedEventCount,
    coverage: found.coverage,
    executed: !result.dryRun,
    storeResults: auditStoreResults,
    deletionManifestHash: result.deletionManifestHash,
  };
}

async function failRequest(q: Queryable, requestId: string, errorCode: string): Promise<void> {
  await q.query(
    `UPDATE erasure_requests SET state = 'failed', error_message = $2, finished_at = now() WHERE id = $1`,
    [requestId, errorCode],
  );
}

function sanitizeErasureStoreResults(
  storeResults: ExecuteResult["storeResults"],
): ExecuteResult["storeResults"] {
  return storeResults.map((result) => {
    if (result.status !== "failed") return result;
    return {
      store: result.store,
      status: result.status,
      count: result.count,
      detail: "store_operation_failed",
    };
  });
}

function blank(
  requestId: string,
  state: ProcessErasureResult["state"],
  error: string,
  matchedEventCount = 0,
  coverage: FindResult["coverage"] = "unknown",
): ProcessErasureResult {
  return { requestId, state, matchedEventCount, coverage, executed: false, storeResults: [], deletionManifestHash: null, error };
}
