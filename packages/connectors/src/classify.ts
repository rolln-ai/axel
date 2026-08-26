/**
 * The single retry/dead classifier for every request-response delivery
 * connector (plain HTTP and signed webhook, in both the Node and Workers
 * runtimes).
 *
 * Policy — this is what `webhook.ts`'s module docstring has always
 * promised ("2xx → success, 4xx except 408/429 → dead, everything else →
 * retry. Same as the plain HTTP connector."), and what
 * `apps/delivery-edge` implemented for its HTTP path. The plain HTTP
 * connector's own implementation had drifted away from that documented
 * contract and classified *every* non-2xx as retryable, which burned the
 * full retry budget on a typo'd URL (404) or a revoked token (401).
 * Restoring the documented policy in one place is the whole point of
 * having this module.
 *
 *   2xx        → success
 *   408, 429   → retry   (request timeout / rate limit — transient by
 *                         definition; the receiver is asking us to come back)
 *   410        → dead    ("Gone": the receiver explicitly unsubscribed)
 *   other 4xx  → dead    (permanent config error — bad URL, bad auth,
 *                         unsupported method, payload the receiver refuses)
 *   3xx/5xx/   → retry
 *   anything
 *   else
 *
 * Network-level failures (thrown by fetch) never reach here; callers map
 * those to "retry" directly.
 */
export type DeliveryOutcomeStatus = "success" | "retry" | "dead";

export function classifyDeliveryStatus(status: number): DeliveryOutcomeStatus {
  if (status >= 200 && status < 300) return "success";
  if (status === 408 || status === 429) return "retry";
  if (status >= 400 && status < 500) return "dead";
  return "retry";
}
