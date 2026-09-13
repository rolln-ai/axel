/**
 * A source lookup failed because its upstream control plane was unavailable or
 * returned an unusable response. This is intentionally distinct from a real
 * `null` source so callers return 503 and never negative-cache an outage.
 */
export const SOURCE_LOOKUP_FAILURE_REASONS = [
  "lookup_failed", "lookup_not_configured", "lookup_timeout", "lookup_network",
  "lookup_http", "lookup_invalid_response", "authority_unavailable", "source_fenced", "authorization_changed",
] as const;
export type SourceLookupFailureReason = typeof SOURCE_LOOKUP_FAILURE_REASONS[number];

export function isSourceLookupFailureReason(value: unknown): value is SourceLookupFailureReason {
  return typeof value === "string"
    && (SOURCE_LOOKUP_FAILURE_REASONS as readonly string[]).includes(value);
}

export class SourceLookupUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: SourceLookupFailureReason = "lookup_failed",
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "SourceLookupUnavailableError";
  }
}
