import { randomUUID } from "node:crypto";
import type { IdempotencyStore } from "@axel/delivery-worker";
import {
  DELIVERY_CLAIM_RENEW_SQL,
  DELIVERY_CLAIM_SETTLE_SQL,
  DELIVERY_CLAIM_SQL,
  decideDeliveryClaim,
} from "@axel/shared";

export type RunIdempotencyQuery = (
  operation: string,
  sql: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface PostgresIdempotencyOptions {
  runQuery: RunIdempotencyQuery;
  /** How long an abandoned in-flight claim blocks a redelivery. */
  claimLeaseMs: number;
  /** Injectable only so claim ownership can be deterministic in unit tests. */
  createClaimToken?: () => string;
}

/**
 * Postgres-backed delivery claim store with restart-safe leases.
 *
 * The claim query preserves completed rows as deduplication state. Failed rows
 * and expired in-flight rows are atomically reclaimed by one contender; fresh
 * in-flight rows remain owned by the active delivery. The owner persists its
 * lease deadline in `expires_at`, so edge and native claimants cannot disagree
 * about when a shared row becomes stale.
 */
export function createPostgresIdempotencyStore(
  options: PostgresIdempotencyOptions,
): IdempotencyStore {
  const leaseMs = positiveInteger(options.claimLeaseMs, "claimLeaseMs");
  const createClaimToken = options.createClaimToken ?? (() => `claim_${randomUUID()}`);

  return {
    renewIntervalMs: Math.max(1, Math.floor(leaseMs / 3)),

    async begin(key) {
      const claimToken = createClaimToken();
      const parts = key.split(":");
      const [workspaceId, eventId, routeId, destinationId] =
        parts.length >= 4 ? parts : ["", "", "", ""];
      const params = [key, workspaceId, eventId, routeId, destinationId, leaseMs, claimToken];

      let first: { rows: Array<Record<string, unknown>> } | null = null;
      try {
        first = await options.runQuery("idempotency-begin", CLAIM_SQL, params);
      } catch (error) {
        // Preserve the old race recovery, but repeat the atomic claim instead
        // of merely reading `in_flight` and ACKing it. A second failure remains
        // an error so the queue retries rather than risking a silent skip.
        if ((error as { code?: string }).code !== "23505") throw error;
      }

      const firstDecision = decideDeliveryClaim(first?.rows[0], claimToken);
      if (firstDecision) return firstDecision;

      // In READ COMMITTED, ON CONFLICT can observe a concurrent insert that the
      // statement's SELECT snapshot cannot yet see. Retry in a new statement;
      // never interpret an empty or unexpected result as permission to send.
      const recovered = await options.runQuery("idempotency-begin-recover", CLAIM_SQL, params);
      const recoveredDecision = decideDeliveryClaim(recovered.rows[0], claimToken);
      if (!recoveredDecision) {
        throw new Error("idempotency claim returned no authoritative state");
      }
      return recoveredDecision;
    },

    async renew(key, token) {
      const result = await options.runQuery(
        "idempotency-renew",
        DELIVERY_CLAIM_RENEW_SQL,
        [key, token, leaseMs],
      );
      return result.rows.length > 0;
    },

    async complete(key, token, attempt) {
      const result = await options.runQuery(
        "idempotency-complete",
        DELIVERY_CLAIM_SETTLE_SQL,
        [key, token, "completed", attempt.attempt_id],
      );
      return result.rows.length > 0;
    },

    async fail(key, token, attempt) {
      const result = await options.runQuery(
        "idempotency-fail",
        DELIVERY_CLAIM_SETTLE_SQL,
        [key, token, "failed", attempt.attempt_id],
      );
      return result.rows.length > 0;
    },
  };
}

export const CLAIM_SQL = DELIVERY_CLAIM_SQL;

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
}
