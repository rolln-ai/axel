/**
 * Client-safe source default limits.
 *
 * Lives in its own file (not source-tokens.ts) so client components can
 * import the constants without pulling in the server-only token generator.
 */
export const DEFAULT_SOURCE_LIMITS = {
  /** 1 MB body cap. */
  maxBodyBytes: 1_048_576,
  /** 100-level JSON depth cap. */
  maxBodyDepth: 100,
  /**
   * 100,000 events/minute = 6M events/hour = 144M/day. A headroom-friendly
   * default that covers high-volume producers (Stripe, Segment) out of the
   * box; tighten it per-source via the dashboard once traffic is known.
   */
  maxEventsPerMinute: 100_000,
};
