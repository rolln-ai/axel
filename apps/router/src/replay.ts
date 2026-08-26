/**
 * Replay processor.
 *
 * The dashboard inserts rows into Postgres `replay_requests` (state=pending).
 * The router service pulls those rows on a periodic loop, claims them via a
 * conditional UPDATE so multiple router replicas can't double-process, fetches
 * the original raw payload from R2, and re-runs `processQueueMessage`.
 *
 * A replay is not "done" when routing/enqueue succeeds. It stays in_progress
 * until the delivery service observes the replayed destination attempt and
 * updates the replay row based on the actual delivery result.
 *
 * This file deliberately has zero dependency on Postgres or R2 SDKs — it
 * accepts the storage interfaces below so the router can wire whatever it
 * already has, and so the test suite can verify the orchestration without
 * spinning up a database.
 */

import { sanitizeConnectorDiagnosticForStorage, type QueueMessage } from "@axel/shared";
import { processQueueMessage, type FanoutScope, type RouterDeps, type RouterProcessResult } from "./processor.ts";

export interface ReplayRow {
  id: string;
  workspace_id: string;
  event_id: string;
  source_id: string;
  r2_key: string;
  scope: "route" | "destination" | "all";
  route_id: string | null;
  destination_id: string | null;
  reason: string | null;
  // Set when this replay was queued by the dashboard's "Replay all unresolved"
  // button (links it to a tracked replay_jobs row); NULL for single-row
  // "Retry" clicks. The router itself ignores it — it is read by the
  // delivery-service worker so a dispatch-failed replay can advance/finish its
  // job (see apps/delivery-service/src/replay-worker.ts).
  replay_job_id: string | null;
}

export interface ReplayStore {
  /**
   * Atomically claim up to `limit` pending replay rows by transitioning them
   * from `pending` to `in_progress`. The implementation must be safe under
   * concurrent calls from multiple router replicas — typically a single
   * `UPDATE … WHERE state='pending' RETURNING …` statement.
   */
  claimPending(limit: number): Promise<ReplayRow[]>;
  markDispatched(id: string, summary: ReplayProcessSummary): Promise<void>;
  markDone(id: string, summary: ReplayProcessSummary): Promise<void>;
  markFailed(id: string, message: string): Promise<void>;
}

export interface ReplayPayloadHints {
  /**
   * Best-effort: replay rows don't carry the original headers/query/content
   * type. The lookup returns whatever R2 customMetadata captured at ingest
   * time so the re-run looks as much like the original event as possible.
   */
  resolveHints(eventId: string, r2Key: string): Promise<{
    received_at?: string;
    content_type?: string;
    size_bytes?: number;
    shard?: number;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    /**
     * The original event's test-flag, carried forward so a replay of a test
     * event stays non-billable. Undefined when the hint lookup couldn't
     * resolve the original row.
     */
    is_test?: boolean;
  } | null>;
}

export interface ReplayProcessorDeps {
  router: RouterDeps;
  replays: ReplayStore;
  hints?: ReplayPayloadHints;
  now?: () => Date;
  /** Maximum rows claimed per loop tick. Default 16. */
  batchSize?: number;
}

export interface ReplayProcessSummary extends RouterProcessResult {
  replay_id: string;
}

/**
 * Raw objects are written only beneath a workspace segment. Validate that
 * invariant again at the privileged replay consumer so a compromised or
 * buggy replay producer cannot turn the account-wide R2 credential into a
 * cross-tenant read primitive.
 */
export function replayPayloadKeyBelongsToWorkspace(key: string, workspaceId: string): boolean {
  const segments = key.split("/");
  return (
    (segments[0] === "events" || segments[0] === "pull") &&
    segments[1] === workspaceId &&
    segments.length >= 3 &&
    segments.slice(2).every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

/**
 * Process one batch of pending replay rows. Returns the per-row summaries.
 *
 * Designed to be called from a periodic loop (e.g. every 30s). Idempotent:
 * if no rows are pending it returns an empty array immediately.
 */
export async function processReplayBatch(deps: ReplayProcessorDeps): Promise<ReplayProcessSummary[]> {
  const limit = deps.batchSize ?? 16;
  const rows = await deps.replays.claimPending(limit);
  if (rows.length === 0) return [];

  const summaries: ReplayProcessSummary[] = [];

  for (const row of rows) {
    try {
      if (!replayPayloadKeyBelongsToWorkspace(row.r2_key, row.workspace_id)) {
        throw new Error("replay_payload_workspace_mismatch");
      }
      const hints = (await deps.hints?.resolveHints(row.event_id, row.r2_key)) ?? null;
      // We tag the synthesized event_id with the replay_id so that the
      // delivery idempotency_key (workspace:event:route:destination) naturally
      // differs from the original delivery — otherwise the delivery worker
      // would short-circuit the replay as "already delivered" and the
      // operator's click would silently no-op. The R2 lookup uses `r2_key`,
      // not event_id, so the original payload is still resolved correctly.
      // Customer destinations receive the suffixed event_id, which is the
      // correct semantic: a replay is a distinct delivery attempt initiated
      // by an operator, distinguishable from the original on the receiver.
      const replayedEventId = replayEventId(row.event_id, row.id);
      const message: QueueMessage = {
        event_id: replayedEventId,
        workspace_id: row.workspace_id,
        source_id: row.source_id,
        r2_key: row.r2_key,
        received_at: hints?.received_at ?? new Date().toISOString(),
        content_type: hints?.content_type ?? "application/json",
        size_bytes: hints?.size_bytes ?? 0,
        shard: hints?.shard ?? 0,
        headers: hints?.headers ?? {},
        query: hints?.query ?? {},
        // Inherit the original event's test-flag so replaying a test event
        // stays non-billable (the rollup counts delivery_attempts WHERE
        // is_test = false). Falls back to false when the hint lookup can't
        // resolve the original row — a real (non-test) event is the safe
        // default for an unknown original.
        is_test: hints?.is_test ?? false,
      };

      // Honor the replay's scope so a route/destination replay doesn't fan out
      // to every active route on the source (audit: scope was stored but never
      // enforced). Build a SCOPED filter only when the target id is actually
      // present — a 'route'/'destination' replay with a null id is a route-level
      // dead letter (a pre-routing failure that delivered nothing), so it
      // re-routes through all routes (scope=undefined). Without this guard a null
      // id slipped past the truthy filter and fanned out (audit: duplicate
      // deliveries). An EXPLICIT under-specified scope is rejected at the API.
      const scope: FanoutScope | undefined =
        row.scope === "destination" && row.destination_id
          ? { routeId: row.route_id, destinationId: row.destination_id }
          : (row.scope === "route" || row.scope === "destination") && row.route_id
            ? { routeId: row.route_id }
            : undefined;
      const result = await processQueueMessage(deps.router, message, scope);
      const summary: ReplayProcessSummary = { ...result, replay_id: row.id };
      if (summary.enqueued_deliveries > 0) {
        await deps.replays.markDispatched(row.id, summary);
      } else {
        await deps.replays.markFailed(row.id, "Replay produced no delivery attempts.");
      }
      summaries.push(summary);
    } catch (err) {
      const message = sanitizeConnectorDiagnosticForStorage(
        err instanceof Error ? err.message : "unknown_replay_error",
        1000,
      );
      await deps.replays.markFailed(row.id, message);
    }
  }

  return summaries;
}

/**
 * Derive a replay-tagged event_id. Visible to customer destinations and to
 * the ClickHouse `events` table; the suffix carries the replay row id so the
 * provenance is traceable.
 */
export function replayEventId(originalEventId: string, replayId: string): string {
  // `replayId` is `rpy_<base64url>` — the prefix is enough to make it obvious.
  return `${originalEventId}#${replayId}`;
}

/**
 * In-memory replay store for tests and local dev. Captures `done` and
 * `failed` writes so test code can assert on them.
 */
export function createInMemoryReplayStore(initial: ReplayRow[] = []): ReplayStore & {
  pending: ReplayRow[];
  dispatched: Map<string, ReplayProcessSummary>;
  done: Map<string, ReplayProcessSummary>;
  failed: Map<string, string>;
} {
  const pending: ReplayRow[] = [...initial];
  const dispatched = new Map<string, ReplayProcessSummary>();
  const done = new Map<string, ReplayProcessSummary>();
  const failed = new Map<string, string>();

  return {
    pending,
    dispatched,
    done,
    failed,
    async claimPending(limit: number) {
      const claimed = pending.splice(0, limit);
      return claimed;
    },
    async markDispatched(id, summary) {
      dispatched.set(id, summary);
    },
    async markDone(id, summary) {
      done.set(id, summary);
    },
    async markFailed(id, message) {
      failed.set(id, message);
    },
  };
}
