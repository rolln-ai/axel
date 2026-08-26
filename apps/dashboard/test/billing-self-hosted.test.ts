import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchBillingEmails } from "../lib/billing/email-dispatcher";
import { buildPlanState, deriveGate } from "../lib/billing/plan-state";

/**
 * Self-hosted mode: no STRIPE_SECRET_KEY means no paid plan exists, so no
 * billing gate may ever block ingest, replays, or send upgrade emails.
 * The cloud-mode (Stripe-configured) matrix lives in billing-plan-state.test.ts;
 * the suite-wide default env comes from test/setup-env.ts.
 */

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

afterEach(() => {
  if (ORIGINAL_KEY !== undefined) process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

describe("deriveGate without Stripe configured", () => {
  it("accepts a free workspace over the cap", () => {
    expect(
      deriveGate({
        workspace_id: "ws_1",
        plan: "free",
        billing_status: "ok",
        total_tasks: 10_000_000,
      }),
    ).toBe("accept");
  });

  it("accepts even a suspended workspace (state is unreachable without Stripe)", () => {
    expect(
      deriveGate({
        workspace_id: "ws_1",
        plan: "pro",
        billing_status: "suspended",
        total_tasks: 0,
      }),
    ).toBe("accept");
  });

  it("still enforces when the caller passes billingConfigured=true explicitly", () => {
    expect(
      deriveGate(
        {
          workspace_id: "ws_1",
          plan: "free",
          billing_status: "ok",
          total_tasks: 10_000,
        },
        true,
      ),
    ).toBe("reject_quota");
  });

  it("buildPlanState carries the accept gate through", () => {
    const state = buildPlanState({
      workspace_id: "ws_1",
      plan: "free",
      billing_status: "canceled",
      total_tasks: 99_999,
    });
    expect(state.gate).toBe("accept");
  });
});

describe("dispatchBillingEmails without Stripe configured", () => {
  it("returns an empty summary without touching Postgres", async () => {
    const pg = {
      query: () => {
        throw new Error("must not query Postgres in self-hosted mode");
      },
    };
    const summary = await dispatchBillingEmails({ pg: pg as never });
    expect(summary).toEqual({ sent: 0, alreadySent: 0, failed: 0, notificationsEmitted: 0 });
  });
});
