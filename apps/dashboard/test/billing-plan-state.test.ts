import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlanState, deriveGate, pushPlanStates } from "../lib/billing/plan-state";

describe("deriveGate", () => {
  it("returns accept for a billing-exempt workspace even over the free cap", () => {
    expect(
      deriveGate({
        workspace_id: "ws_exempt",
        plan: "free",
        billing_status: "ok",
        total_tasks: 10_000_000,
        billing_exempt: true,
      }),
    ).toBe("accept");
  });

  it("returns accept for a billing-exempt workspace even when suspended/canceled", () => {
    expect(
      deriveGate({
        workspace_id: "ws_exempt",
        plan: "pro",
        billing_status: "suspended",
        total_tasks: 0,
        billing_exempt: true,
      }),
    ).toBe("accept");
    expect(
      deriveGate({
        workspace_id: "ws_exempt",
        plan: "free",
        billing_status: "canceled",
        total_tasks: 10_000_000,
        billing_exempt: true,
      }),
    ).toBe("accept");
  });

  it("returns reject_suspended for any plan when billing_status is suspended", () => {
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "free",
        billing_status: "suspended",
        total_tasks: 0,
      }),
    ).toBe("reject_suspended");
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "pro",
        billing_status: "suspended",
        total_tasks: 99,
      }),
    ).toBe("reject_suspended");
  });

  it("returns reject_suspended for canceled subscriptions", () => {
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "pro",
        billing_status: "canceled",
        total_tasks: 0,
      }),
    ).toBe("reject_suspended");
  });

  it("returns reject_quota for free workspaces at or above the 10k cap", () => {
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "free",
        billing_status: "ok",
        total_tasks: 10_000,
      }),
    ).toBe("reject_quota");
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "free",
        billing_status: "ok",
        total_tasks: 50_000,
      }),
    ).toBe("reject_quota");
  });

  it("accepts free workspaces under the cap", () => {
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "free",
        billing_status: "ok",
        total_tasks: 9_999,
      }),
    ).toBe("accept");
  });

  it("never rejects pro workspaces on volume — overage is reported, not gated", () => {
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "pro",
        billing_status: "ok",
        total_tasks: 5_000_000,
      }),
    ).toBe("accept");
  });

  it("keeps past_due workspaces in accept (dunning continues; ingest must flow)", () => {
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "pro",
        billing_status: "past_due",
        total_tasks: 100,
      }),
    ).toBe("accept");
  });

  it("treats grace as accept (Stripe is still trying to charge)", () => {
    expect(
      deriveGate({
        workspace_id: "ws_a",
        plan: "pro",
        billing_status: "grace",
        total_tasks: 0,
      }),
    ).toBe("accept");
  });
});

describe("buildPlanState", () => {
  it("stamps computed_at as ISO of the injected clock", () => {
    const state = buildPlanState(
      {
        workspace_id: "ws_a",
        plan: "free",
        billing_status: "ok",
        total_tasks: 0,
      },
      new Date("2026-05-15T01:23:45Z"),
    );
    expect(state).toMatchObject({
      workspace_id: "ws_a",
      plan: "free",
      gate: "accept",
      computed_at: "2026-05-15T01:23:45.000Z",
    });
  });
});

describe("pushPlanStates", () => {
  beforeEach(() => {
    process.env.INGEST_ADMIN_URL = "https://ingest.axelapp.ai/admin/source-cache/invalidate";
    process.env.INGEST_ADMIN_TOKEN = "test-admin-token";
  });
  afterEach(() => {
    delete process.env.INGEST_ADMIN_URL;
    delete process.env.INGEST_ADMIN_TOKEN;
  });

  it("rewrites the admin URL to /admin/workspace-plan/put", async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers: Record<string, string> = {};
      const initHeaders = (init?.headers ?? {}) as Record<string, string>;
      for (const k of Object.keys(initHeaders)) headers[k] = initHeaders[k]!;
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers,
      });
      return new Response(null, { status: 204 });
    };
    const summary = await pushPlanStates(
      [
        {
          workspace_id: "ws_a",
          plan: "free",
          gate: "accept",
          computed_at: "2026-05-15T00:00:00.000Z",
        },
      ],
      { fetch: fakeFetch },
    );
    expect(summary.pushed).toBe(1);
    expect(summary.errors).toBe(0);
    expect(calls[0]?.url).toBe("https://ingest.axelapp.ai/admin/workspace-plan/put");
    expect(calls[0]?.headers["x-axel-admin-token"]).toBe("test-admin-token");
    // ttl_seconds must outlive the cron interval (hourly = 3600s) so a
    // single missed push doesn't leave the gate stale. Bug recurrence
    // would be the worker's default 300s TTL.
    const body = calls[0]?.body as { ttl_seconds?: number };
    expect(body.ttl_seconds).toBeGreaterThanOrEqual(3600);
  });

  it("reports errors per failed push without aborting the run", async () => {
    let n = 0;
    const fakeFetch: typeof fetch = async () => {
      n += 1;
      if (n === 2) throw new Error("network");
      return new Response(null, { status: 204 });
    };
    const summary = await pushPlanStates(
      [
        { workspace_id: "ws_a", plan: "free", gate: "accept", computed_at: "x" },
        { workspace_id: "ws_b", plan: "free", gate: "accept", computed_at: "x" },
        { workspace_id: "ws_c", plan: "free", gate: "accept", computed_at: "x" },
      ],
      { fetch: fakeFetch },
    );
    expect(summary).toEqual({ pushed: 2, errors: 1, skipped: 0 });
  });

  it("skips when INGEST_ADMIN_URL is unset (weak-enforcement deployment)", async () => {
    delete process.env.INGEST_ADMIN_URL;
    let called = 0;
    const fakeFetch: typeof fetch = async () => {
      called += 1;
      return new Response(null, { status: 204 });
    };
    const summary = await pushPlanStates(
      [{ workspace_id: "ws_a", plan: "free", gate: "accept", computed_at: "x" }],
      { fetch: fakeFetch },
    );
    expect(summary).toEqual({ pushed: 0, errors: 0, skipped: 1 });
    expect(called).toBe(0);
  });
});
