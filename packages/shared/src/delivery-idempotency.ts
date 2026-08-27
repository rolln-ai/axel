/**
 * Shared Postgres protocol for native and edge delivery ownership.
 *
 * `attempt_id` holds an opaque claim token while a row is `in_flight`. A
 * terminal settlement replaces it with the public delivery attempt id. The
 * lease deadline lives in `expires_at`, so every claimant observes the lease
 * chosen by the current owner instead of applying its own timeout to another
 * runtime's claim.
 */

export const DEFAULT_DELIVERY_CLAIM_LEASE_MS = 360_000;
export const MAX_DELIVERY_CLAIM_LEASE_MS = 11 * 60 * 60 * 1_000;
/** Keep completed claims for the full raw-event R2 retention window. */
export const DELIVERY_CLAIM_RETENTION_DAYS = 30;

export type DeliveryClaimState = "in_flight" | "completed" | "failed";

export interface DeliveryClaimRow extends Record<string, unknown> {
  state: DeliveryClaimState;
  claimed: boolean;
  claim_token: string | null;
  claim_expires_at?: Date | string | null;
}

export type DeliveryClaimDecision =
  | { status: "started"; token: string }
  | { status: "duplicate"; retry_after_ms?: number }
  | { status: "completed" };

/**
 * Parameters: key, workspace, event, route, destination, lease ms, token.
 *
 * The `attempt_id IS NULL` branch is a rolling-upgrade bridge for claims made
 * by older releases that stored a 14-day retention deadline in `expires_at`
 * and no owner token. New tokenized claims use their persisted lease deadline,
 * then keep terminal claims for 30 days.
 */
export const DELIVERY_CLAIM_SQL = `WITH claimed AS (
  INSERT INTO delivery_idempotency
    (idempotency_key, workspace_id, event_id, route_id, destination_id, state, attempt_id, expires_at)
  VALUES (
    $1, $2, $3, $4, $5, 'in_flight', $7,
    now() + ($6::bigint * interval '1 millisecond')
  )
  ON CONFLICT (idempotency_key) DO UPDATE
    SET state = 'in_flight',
        attempt_id = EXCLUDED.attempt_id,
        updated_at = now(),
        expires_at = EXCLUDED.expires_at
  WHERE delivery_idempotency.state = 'failed'
     OR (
       delivery_idempotency.state = 'in_flight'
       AND (
         delivery_idempotency.expires_at <= now()
         OR (
           delivery_idempotency.attempt_id IS NULL
           AND delivery_idempotency.updated_at <= now() - ($6::bigint * interval '1 millisecond')
         )
       )
     )
  RETURNING state, true AS claimed, attempt_id AS claim_token, expires_at AS claim_expires_at
)
SELECT state, claimed, claim_token, claim_expires_at FROM claimed
UNION ALL
SELECT existing.state, false AS claimed, existing.attempt_id AS claim_token,
       existing.expires_at AS claim_expires_at
  FROM delivery_idempotency existing
 WHERE existing.idempotency_key = $1
   AND NOT EXISTS (SELECT 1 FROM claimed)
LIMIT 1`;

/** Parameters: key, token, lease ms. */
export const DELIVERY_CLAIM_RENEW_SQL = `UPDATE delivery_idempotency
   SET updated_at = now(),
       expires_at = now() + ($3::bigint * interval '1 millisecond')
 WHERE idempotency_key = $1
   AND state = 'in_flight'
   AND attempt_id = $2
 RETURNING true AS updated`;

/** Parameters: key, token, terminal state, attempt id. */
export const DELIVERY_CLAIM_SETTLE_SQL = `UPDATE delivery_idempotency
   SET state = $3::text,
       attempt_id = $4,
       updated_at = now(),
       expires_at = now() + interval '${DELIVERY_CLAIM_RETENTION_DAYS} days'
 WHERE idempotency_key = $1
   AND state = 'in_flight'
   AND attempt_id = $2
 RETURNING true AS updated`;

export function decideDeliveryClaim(
  value: Record<string, unknown> | undefined,
  candidateToken: string,
): DeliveryClaimDecision | null {
  if (!value) return null;
  const row = value as DeliveryClaimRow;
  if (row.claimed === true && row.state === "in_flight" && row.claim_token === candidateToken) {
    return { status: "started", token: candidateToken };
  }
  if (row.claimed === false && row.state === "completed") return { status: "completed" };
  if (row.claimed === false && row.state === "in_flight") {
    // This is the second statement after an indeterminate first result when the
    // token matches. A different token always belongs to another live owner.
    if (row.claim_token === candidateToken) return { status: "started", token: candidateToken };
    // Older untokenized rows carry their original 14-day retention deadline
    // rather than a lease deadline. Let the caller use its normal lease-sized
    // retry delay. New terminal rows remain for 30 days.
    if (row.claim_token === null) return { status: "duplicate" };
    const expiresAt = row.claim_expires_at instanceof Date
      ? row.claim_expires_at.getTime()
      : typeof row.claim_expires_at === "string"
        ? Date.parse(row.claim_expires_at)
        : Number.NaN;
    const retryAfterMs = expiresAt - Date.now();
    return Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? { status: "duplicate", retry_after_ms: retryAfterMs }
      : { status: "duplicate" };
  }
  return null;
}
