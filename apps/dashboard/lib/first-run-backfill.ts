/**
 * Pure presentation logic for first-run setup's catch-up panel.
 *
 * Two things here are easy to get subtly wrong, so they live in one tested
 * place rather than inline in JSX:
 *
 *  - A job reaching `done` only means it finished ENQUEUEING replays. The
 *    deliveries drain afterwards, so treating `done` as "finished" reports a
 *    number lower than what actually landed.
 *  - The progress percentage divides by an estimate that can be 0 (ClickHouse
 *    unavailable) or lower than reality (events arriving mid-backfill).
 */

export interface BackfillProgressInput {
  state: "pending" | "running" | "done" | "failed" | "cancelled";
  settled: boolean;
  enqueued: number;
  delivered: number;
  /** Replays that reached a terminal failure (dead-lettered). */
  failed?: number;
  totalEstimated: number | null;
  /** Client-side fallback for the total when the job row has no estimate. */
  fallbackEstimate?: number;
}

export interface BackfillProgress {
  /** Safe to stop polling and show a final count. */
  finished: boolean;
  /** What we can honestly say was delivered. */
  synced: number;
  /** Replays that will never land. */
  failed: number;
  /** Denominator for the progress bar; never 0. */
  total: number;
  /** 0–100, clamped. */
  percent: number;
  /** The run ended without delivering everything it enqueued. */
  incomplete: boolean;
}

export function summarizeBackfillProgress(
  input: BackfillProgressInput,
): BackfillProgress {
  const delivered = Math.max(0, input.delivered);
  const enqueued = Math.max(0, input.enqueued);
  const failed = Math.max(0, input.failed ?? 0);
  // Every replay has reached a terminal state — delivered or dead. Counting
  // only successes left the panel spinning forever when a misconfigured
  // destination dead-lettered the lot.
  const accountedFor = delivered + failed >= enqueued;
  // 'failed'/'cancelled' are terminal even with deliveries outstanding —
  // nothing more is coming, so stop and say what actually landed.
  const terminalEarly = input.state === "failed" || input.state === "cancelled";
  const finished = terminalEarly || (input.settled && accountedFor);

  const total = Math.max(
    input.totalEstimated ?? 0,
    input.fallbackEstimate ?? 0,
    enqueued,
    delivered + failed,
    1,
  );
  const percent = Math.min(100, Math.max(0, Math.round((delivered / total) * 100)));

  return {
    finished,
    synced: delivered,
    failed,
    total,
    percent,
    incomplete: finished && delivered < enqueued,
  };
}
