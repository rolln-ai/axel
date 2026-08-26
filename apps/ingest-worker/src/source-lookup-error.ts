/**
 * A source lookup failed because its upstream control plane was unavailable or
 * returned an unusable response. This is intentionally distinct from a real
 * `null` source so callers return 503 and never negative-cache an outage.
 */
export class SourceLookupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceLookupUnavailableError";
  }
}
