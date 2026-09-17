/**
 * Dead-letter triage worker.
 *
 * Every tick, pick up unresolved dead letters nobody has triaged, ask Jev
 * (TypeSafe AI) for a typed reason, and store it on the row. When Jev says
 * the failure was transient and is sure, queue a replay the existing replay
 * processor will pick up. Everything else stays in the inbox with its label
 * so a person can decide.
 *
 * Runs only when TYPESAFE_API_KEY is set and only in the worker role, like
 * the replay and backfill workers. Each tick is bounded (batch size, replay
 * cap) and a Jev outage just leaves rows untriaged until the next tick.
 *
 * Auto-replay guards, all of which must pass:
 *   - Jev chose `transient` at or above the confidence floor (default 0.9)
 *   - the dead-letter reason is one a replay can fix
 *   - the failure is old enough that a blip has had time to pass
 *   - the route id is known and the fingerprint has no active mute
 *   - no identical replay is already pending or in progress
 *   - the per-tick replay cap has not been reached
 *   - this dead letter has never been auto-replayed before (one shot)
 */

import type { Pool } from "pg";
import { startPeriodicRunner, type RunnerHandle } from "@axel/router";
import {
  DEAD_LETTER_AUTO_REPLAY_MIN_CONFIDENCE,
  JevError,
  shouldAutoReplay,
  triageDeadLetter,
  type DeadLetterTriageReason,
  type DeadLetterTriageResult,
  type JevInferenceConfig,
} from "@axel/shared";

/** replay_requests.reason stamped on automatic replays, visible in the dashboard. */
export const AUTO_REPLAY_REASON = "auto_replay_transient";

export interface DeadLetterTriageWorkerDeps {
  pool: Pool;
  jev: JevInferenceConfig;
  /** Tick interval. Default 60s. */
  intervalMs?: number;
  /** Rows triaged per tick. Default 25. */
  batchSize?: number;
  /** Queue replays for confident transient failures. Default true. */
  autoReplay?: boolean;
  /** Confidence floor for auto-replay. Default 0.8. */
  minConfidence?: number;
  /** Do not replay a failure younger than this. Default 5 minutes. */
  replayDelayMs?: number;
  /** Replays queued per tick at most. Default 50. */
  maxAutoReplaysPerTick?: number;
  /** Only look back this far for untriaged rows. Default 7 days. */
  lookbackMs?: number;
  now?: () => Date;
  alertSink?: Parameters<typeof startPeriodicRunner>[1] extends { alertSink?: infer S } ? S : never;
}

export interface TriageTickSummary {
  scanned: number;
  triaged: number;
  auto_replayed: number;
  skipped_claimed: number;
  by_reason: Partial<Record<DeadLetterTriageReason, number>>;
  /** Set when the tick stopped early because Jev failed. */
  jev_error: string | null;
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  event_id: string;
  source_id: string;
  route_id: string;
  destination_id: string | null;
  r2_key: string;
  reason: string;
  message: string;
  fingerprint: string | null;
  errored_at: string;
  destination_type: string | null;
}

interface FingerprintStatsRow {
  same_1h: string | number;
  same_24h: string | number;
  resolved_24h: string | number;
  replay_failures_24h: string | number;
  is_muted: boolean;
}

export async function runDeadLetterTriageOnce(
  deps: DeadLetterTriageWorkerDeps,
): Promise<TriageTickSummary> {
  const now = deps.now ?? (() => new Date());
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? 25, 200));
  const lookbackMs = deps.lookbackMs ?? 7 * 86_400_000;
  const summary: TriageTickSummary = {
    scanned: 0,
    triaged: 0,
    auto_replayed: 0,
    skipped_claimed: 0,
    by_reason: {},
    jev_error: null,
  };

  const candidates = await deps.pool.query<CandidateRow>(
    `SELECT dl.id::text AS id,
            dl.workspace_id, dl.event_id, dl.source_id, dl.route_id,
            NULLIF(dl.destination_id, '') AS destination_id,
            dl.r2_key, dl.reason, dl.message, dl.fingerprint,
            dl.errored_at::text AS errored_at,
            d.type AS destination_type
       FROM dead_letters dl
       LEFT JOIN destinations d
              ON d.id = dl.destination_id
             AND d.workspace_id = dl.workspace_id
      WHERE dl.resolved_at IS NULL
        AND dl.triaged_at IS NULL
        AND dl.errored_at > $1::timestamptz
      ORDER BY dl.errored_at DESC
      LIMIT $2`,
    [new Date(now().getTime() - lookbackMs).toISOString(), batchSize],
  );
  summary.scanned = candidates.rows.length;

  for (const row of candidates.rows) {
    const stats = await loadFingerprintStats(deps.pool, row);
    const ageMinutes = Math.max(0, (now().getTime() - Date.parse(row.errored_at)) / 60_000);

    let triage: DeadLetterTriageResult;
    try {
      triage = await triageDeadLetter(
        {
          reason: row.reason,
          message: row.message,
          destination_type: row.destination_type,
          same_fingerprint_1h: stats.same_1h,
          same_fingerprint_24h: stats.same_24h,
          replay_successes_24h: stats.resolved_24h,
          replay_failures_24h: stats.replay_failures_24h,
          age_minutes: ageMinutes,
        },
        deps.jev,
      );
    } catch (err) {
      // A Jev problem is almost always systemic (key, outage, quota). Stop
      // the tick; untriaged rows are picked up again next time.
      summary.jev_error = err instanceof JevError ? err.message : String(err);
      break;
    }

    // Claim: only the first writer wins, so a second replica or a re-run
    // never double-replays.
    const claimed = await deps.pool.query<{ id: string }>(
      `UPDATE dead_letters
          SET triage_reason = $2,
              triage_confidence = $3,
              triaged_at = now()
        WHERE id = $1::bigint
          AND triaged_at IS NULL
      RETURNING id::text AS id`,
      [row.id, triage.reason, triage.confidence],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      summary.skipped_claimed += 1;
      continue;
    }
    summary.triaged += 1;
    summary.by_reason[triage.reason] = (summary.by_reason[triage.reason] ?? 0) + 1;

    const wantsReplay =
      (deps.autoReplay ?? true)
      && shouldAutoReplay(triage, row.reason, deps.minConfidence ?? DEAD_LETTER_AUTO_REPLAY_MIN_CONFIDENCE)
      && row.route_id !== ""
      && !stats.is_muted
      && ageMinutes * 60_000 >= (deps.replayDelayMs ?? 5 * 60_000)
      && summary.auto_replayed < (deps.maxAutoReplaysPerTick ?? 50);
    if (!wantsReplay) continue;

    const replayId = await queueAutoReplay(deps.pool, row);
    if (!replayId) continue;
    await deps.pool.query(
      `UPDATE dead_letters SET auto_replay_id = $2 WHERE id = $1::bigint`,
      [row.id, replayId],
    );
    summary.auto_replayed += 1;
  }

  return summary;
}

async function loadFingerprintStats(
  pool: Pool,
  row: CandidateRow,
): Promise<{
  same_1h: number;
  same_24h: number;
  resolved_24h: number;
  replay_failures_24h: number;
  is_muted: boolean;
}> {
  if (!row.fingerprint) {
    return { same_1h: 1, same_24h: 1, resolved_24h: 0, replay_failures_24h: 0, is_muted: false };
  }
  const res = await pool.query<FingerprintStatsRow>(
    `SELECT
       (SELECT count(*) FROM dead_letters
         WHERE workspace_id = $1 AND fingerprint = $2
           AND errored_at > now() - interval '1 hour') AS same_1h,
       (SELECT count(*) FROM dead_letters
         WHERE workspace_id = $1 AND fingerprint = $2
           AND errored_at > now() - interval '24 hours') AS same_24h,
       (SELECT count(*) FROM dead_letters
         WHERE workspace_id = $1 AND fingerprint = $2
           AND resolved_by_replay_id IS NOT NULL
           AND resolved_at > now() - interval '24 hours') AS resolved_24h,
       (SELECT count(*) FROM replay_requests rr
          JOIN dead_letters dl
            ON dl.workspace_id = rr.workspace_id
           AND dl.event_id = rr.event_id
           AND dl.route_id IS NOT DISTINCT FROM rr.route_id
         WHERE dl.workspace_id = $1 AND dl.fingerprint = $2
           AND rr.state = 'failed'
           AND rr.finished_at > now() - interval '24 hours') AS replay_failures_24h,
       EXISTS (
         SELECT 1 FROM dead_letter_mutes m
          WHERE m.workspace_id = $1 AND m.fingerprint = $2
            AND (m.until IS NULL OR m.until > now())
       ) AS is_muted`,
    [row.workspace_id, row.fingerprint],
  );
  const r = res.rows[0];
  return {
    same_1h: Number(r?.same_1h ?? 1),
    same_24h: Number(r?.same_24h ?? 1),
    resolved_24h: Number(r?.resolved_24h ?? 0),
    replay_failures_24h: Number(r?.replay_failures_24h ?? 0),
    is_muted: Boolean(r?.is_muted),
  };
}

/**
 * Queue one replay for the dead letter, matching the dashboard's shape: a
 * destination scope when the failure names a destination, a route scope
 * otherwise. Returns null when an identical replay is already in flight.
 */
async function queueAutoReplay(pool: Pool, row: CandidateRow): Promise<string | null> {
  const scope = row.destination_id ? "destination" : "route";
  const inFlight = await pool.query<{ id: string }>(
    `SELECT id FROM replay_requests
      WHERE workspace_id = $1
        AND event_id = $2
        AND scope = $3
        AND route_id IS NOT DISTINCT FROM $4
        AND destination_id IS NOT DISTINCT FROM $5
        AND state IN ('pending', 'in_progress')
      LIMIT 1`,
    [row.workspace_id, row.event_id, scope, row.route_id, row.destination_id],
  );
  if ((inFlight.rowCount ?? 0) > 0) return null;

  const id = generateAutoReplayId();
  await pool.query(
    `INSERT INTO replay_requests
       (id, workspace_id, event_id, source_id, r2_key, scope, route_id, destination_id, state, reason, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
    [
      id,
      row.workspace_id,
      row.event_id,
      row.source_id,
      row.r2_key,
      scope,
      row.route_id,
      row.destination_id,
      AUTO_REPLAY_REASON,
      row.reason,
    ],
  );
  return id;
}

function generateAutoReplayId(): string {
  return `rpa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function startDeadLetterTriageWorker(deps: DeadLetterTriageWorkerDeps): RunnerHandle {
  const intervalMs = deps.intervalMs ?? 60_000;
  return startPeriodicRunner(
    [
      {
        name: "dead_letter_triage",
        intervalMs,
        runOnStart: true,
        run: async () => {
          const s = await runDeadLetterTriageOnce(deps);
          if (s.jev_error) {
            console.warn(`[triage] jev failed, will retry next tick: ${s.jev_error}`);
          }
          if (s.triaged > 0) {
            const reasons = Object.entries(s.by_reason)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ");
            console.log(
              `[triage] triaged=${s.triaged} auto_replayed=${s.auto_replayed} ${reasons}`,
            );
          }
        },
      },
    ],
    deps.alertSink ? { alertSink: deps.alertSink } : {},
  );
}
