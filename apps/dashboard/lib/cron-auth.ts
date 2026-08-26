import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Audit-pass2 — timing-safe equivalence check for cron + ops
 * bearer-token paths. Plain `===` on JS strings short-circuits at
 * the first differing byte, which leaks the prefix length over
 * many slow-path measurements. Hash both sides before comparing
 * so length mismatches don't crash `timingSafeEqual`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * Common cron authorization: accepts either `Authorization: Bearer
 * $CRON_SECRET` (Vercel's standard) or `x-axel-ops-token:
 * $OPS_TEST_TOKEN` (for manual cron triggers during incident
 * response). Returns true if either matches.
 */
export function isCronAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (cronSecret && auth && auth.startsWith("Bearer ")) {
    if (constantTimeEqual(auth.slice("Bearer ".length), cronSecret)) return true;
  }
  const opsToken = process.env.OPS_TEST_TOKEN;
  const provided = request.headers.get("x-axel-ops-token");
  if (opsToken && provided && constantTimeEqual(provided, opsToken)) return true;
  return false;
}
