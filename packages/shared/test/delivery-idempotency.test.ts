import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_CLAIM_RENEW_SQL,
  DELIVERY_CLAIM_SETTLE_SQL,
  DELIVERY_CLAIM_SQL,
  decideDeliveryClaim,
} from "../src/delivery-idempotency.ts";

describe("shared delivery claim protocol", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps claim, renewal, and settlement fenced by the opaque owner token", () => {
    expect(DELIVERY_CLAIM_SQL).toContain("attempt_id = EXCLUDED.attempt_id");
    expect(DELIVERY_CLAIM_SQL).toContain("delivery_idempotency.expires_at <= now()");
    expect(DELIVERY_CLAIM_RENEW_SQL).toContain("AND state = 'in_flight'");
    expect(DELIVERY_CLAIM_RENEW_SQL).toContain("AND attempt_id = $2");
    expect(DELIVERY_CLAIM_SETTLE_SQL).toContain("AND state = 'in_flight'");
    expect(DELIVERY_CLAIM_SETTLE_SQL).toContain("AND attempt_id = $2");
  });

  it("distinguishes an indeterminate retry from another live owner", () => {
    expect(decideDeliveryClaim({
      state: "in_flight",
      claimed: false,
      claim_token: "claim_ours",
    }, "claim_ours")).toEqual({ status: "started", token: "claim_ours" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    expect(decideDeliveryClaim({
      state: "in_flight",
      claimed: false,
      claim_token: "claim_native",
      claim_expires_at: "2026-08-26T12:06:00.000Z",
    }, "claim_edge")).toEqual({ status: "duplicate", retry_after_ms: 360_000 });
  });
});
