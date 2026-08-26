export interface PollIdleBackoff {
  /** Return the delay to use after an empty pull, then advance the backoff. */
  nextEmptyDelayMs(): number;
  /** Return to the active polling interval after a pull returns work. */
  reset(): void;
}

/**
 * Exponential idle backoff for Cloudflare HTTP-pull consumers.
 *
 * Cloudflare bills an empty pull as a Queue read operation, so a permanently
 * idle one-second loop can exhaust the free allowance by itself. Keeping this
 * state separate from the poll loop makes the quota behavior deterministic
 * and lets production leave backoff disabled by setting max equal to base.
 */
export function createPollIdleBackoff(
  baseIntervalMs: number,
  maxIdleIntervalMs: number,
): PollIdleBackoff {
  const base = positiveInteger(baseIntervalMs, "baseIntervalMs");
  const max = Math.max(base, positiveInteger(maxIdleIntervalMs, "maxIdleIntervalMs"));
  let nextDelay = base;

  return {
    nextEmptyDelayMs() {
      const delay = nextDelay;
      nextDelay = Math.min(max, nextDelay * 2);
      return delay;
    },
    reset() {
      nextDelay = base;
    },
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
}
