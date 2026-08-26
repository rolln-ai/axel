import { describe, expect, it, vi } from "vitest";
import type { DeliveryAttempt } from "@axel/shared";
import {
  CLAIM_SQL,
  createPostgresIdempotencyStore,
  type RunIdempotencyQuery,
} from "../src/postgres-idempotency.ts";

const key = "ws_1:evt_1:rt_1:dst_1";

function result(
  state: "in_flight" | "completed" | "failed",
  claimed: boolean,
  claimToken: string | null = "owner-a",
) {
  return { rows: [{ state, claimed, claim_token: claimToken }] };
}

const deliveryAttempt = { attempt_id: "att-1" } as DeliveryAttempt;

describe("Postgres idempotency claim lease", () => {
  it("claims a new row and passes identity plus the bounded lease atomically", async () => {
    const runQuery = vi.fn(async () => result("in_flight", true));
    const store = createPostgresIdempotencyStore({
      runQuery: runQuery as RunIdempotencyQuery,
      claimLeaseMs: 360_000,
      createClaimToken: () => "owner-a",
    });

    await expect(store.begin(key)).resolves.toEqual({ status: "started", token: "owner-a" });
    expect(runQuery).toHaveBeenCalledWith(
      "idempotency-begin",
      CLAIM_SQL,
      [key, "ws_1", "evt_1", "rt_1", "dst_1", 360_000, "owner-a"],
    );
    expect(store.renewIntervalMs).toBe(120_000);
    expect(CLAIM_SQL).toContain("delivery_idempotency.state = 'failed'");
    expect(CLAIM_SQL).toContain("delivery_idempotency.updated_at <=");
    expect(CLAIM_SQL).toContain("delivery_idempotency.expires_at <= now()");
    expect(CLAIM_SQL).toContain("expires_at = EXCLUDED.expires_at");
    expect(CLAIM_SQL).toContain("attempt_id = EXCLUDED.attempt_id");
  });

  it("preserves completed rows as terminal duplicates", async () => {
    const store = createPostgresIdempotencyStore({
      runQuery: (async () => result("completed", false)) as RunIdempotencyQuery,
      claimLeaseMs: 360_000,
    });

    await expect(store.begin(key)).resolves.toEqual({ status: "completed" });
  });

  it("does not steal a fresh in-flight claim", async () => {
    const store = createPostgresIdempotencyStore({
      runQuery: (async () => result("in_flight", false)) as RunIdempotencyQuery,
      claimLeaseMs: 360_000,
    });

    await expect(store.begin(key)).resolves.toEqual({ status: "duplicate" });
  });

  it("allows exactly the atomic stale-claim winner to restart delivery", async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(result("in_flight", true, "owner-a"))
      .mockResolvedValueOnce(result("in_flight", false, "owner-a"));
    const createClaimToken = vi
      .fn()
      .mockReturnValueOnce("owner-a")
      .mockReturnValueOnce("owner-b");
    const store = createPostgresIdempotencyStore({
      runQuery: runQuery as RunIdempotencyQuery,
      claimLeaseMs: 360_000,
      createClaimToken,
    });

    await expect(store.begin(key)).resolves.toEqual({ status: "started", token: "owner-a" });
    await expect(store.begin(key)).resolves.toEqual({ status: "duplicate" });
  });

  it("retries an indeterminate conflict in a new statement and never guesses started", async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(result("completed", false));
    const store = createPostgresIdempotencyStore({
      runQuery: runQuery as RunIdempotencyQuery,
      claimLeaseMs: 360_000,
    });

    await expect(store.begin(key)).resolves.toEqual({ status: "completed" });
    expect(runQuery.mock.calls.map((call) => call[0])).toEqual([
      "idempotency-begin",
      "idempotency-begin-recover",
    ]);
  });

  it("fails closed when neither atomic claim query returns authoritative state", async () => {
    const store = createPostgresIdempotencyStore({
      runQuery: (async () => ({ rows: [] })) as RunIdempotencyQuery,
      claimLeaseMs: 360_000,
    });

    await expect(store.begin(key)).rejects.toThrow("no authoritative state");
  });

  it("renews only the matching live owner", async () => {
    const runQuery = vi.fn(async () => ({ rows: [{ updated: true }] }));
    const store = createPostgresIdempotencyStore({
      runQuery: runQuery as RunIdempotencyQuery,
      claimLeaseMs: 360_000,
    });

    await expect(store.renew(key, "owner-a")).resolves.toBe(true);
    expect(runQuery).toHaveBeenCalledWith(
      "idempotency-renew",
      expect.stringContaining("AND attempt_id = $2"),
      [key, "owner-a", 360_000],
    );
    expect(runQuery.mock.calls[0]?.[1]).toContain("AND state = 'in_flight'");
  });

  it("does not let a stale owner complete or fail the current claim", async () => {
    let currentState = "in_flight";
    const currentOwner = "owner-new";
    const runQuery = vi.fn(async (operation: string, _sql: string, params: unknown[]) => {
      if (
        operation === "idempotency-renew" &&
        currentState === "in_flight" &&
        params[1] === currentOwner
      ) {
        return { rows: [{ updated: true }] };
      }
      if (
        (operation === "idempotency-complete" || operation === "idempotency-fail") &&
        currentState === "in_flight" &&
        params[1] === currentOwner
      ) {
        currentState = operation === "idempotency-complete" ? "completed" : "failed";
        return { rows: [{ updated: true }] };
      }
      return { rows: [] };
    });
    const store = createPostgresIdempotencyStore({
      runQuery: runQuery as RunIdempotencyQuery,
      claimLeaseMs: 360_000,
    });

    await expect(store.renew(key, "owner-stale")).resolves.toBe(false);
    await expect(store.complete(key, "owner-stale", deliveryAttempt)).resolves.toBe(false);
    await expect(store.fail(key, "owner-stale", deliveryAttempt)).resolves.toBe(false);
    expect(currentState).toBe("in_flight");
    for (const [operation, sql, params] of runQuery.mock.calls) {
      expect(sql).toContain("AND state = 'in_flight'");
      expect(sql).toContain("AND attempt_id = $2");
      expect(params).toEqual(
        operation === "idempotency-renew"
          ? [key, "owner-stale", 360_000]
          : [
              key,
              "owner-stale",
              operation === "idempotency-complete" ? "completed" : "failed",
              "att-1",
            ],
      );
    }
  });
});
