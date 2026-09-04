import { describe, expect, it, vi } from "vitest";
import { fakeClickhouse } from "@axel/test-utils";
import type Stripe from "stripe";
import type { Queryable } from "../lib/db";
import type { ClickhouseQueryable } from "../lib/clickhouse";
import { cancelSubscriptionWithFinalInvoice } from "../lib/billing/cancellation";
import { flushWorkspaceMeterUsage } from "../lib/billing/meter-reporter";
import {
  publicWorkspaceTeardownSweepSummary,
  sweepWorkspaceTeardowns,
  teardownSingleWorkspace,
  WorkspaceTeardownSweepError,
} from "../lib/workspace-teardown";

/* ----------------------------- fakes ----------------------------- */

function fakeStripe() {
  const meterEvents: Stripe.Billing.MeterEventCreateParams[] = [];
  const cancels: Array<{ id: string; params?: Stripe.SubscriptionCancelParams }> = [];
  const stripe = {
    billing: {
      meterEvents: {
        async create(params: Stripe.Billing.MeterEventCreateParams) {
          meterEvents.push(params);
          return { identifier: params.identifier } as Stripe.Billing.MeterEvent;
        },
      },
    },
    subscriptions: {
      async cancel(id: string, params?: Stripe.SubscriptionCancelParams) {
        cancels.push({ id, ...(params ? { params } : {}) });
        return { id, status: "canceled" } as Stripe.Subscription;
      },
    },
  } as unknown as Pick<Stripe, "billing" | "subscriptions">;
  return { stripe, meterEvents, cancels };
}

// ClickHouse fake: routes by which table the query hits.
function fakeCh(byTable: { events?: Array<{ day: string; tasks: string }>; delivery?: Array<{ day: string; tasks: string }> }): ClickhouseQueryable {
  return fakeClickhouse({
    responses: (sql) => (sql.includes("FROM events") ? byTable.events ?? [] : byTable.delivery ?? []),
  }).client;
}

// Postgres fake: canned SELECT for the deleting sweep, records mutations.
function fakePg(deletingRows: Array<Record<string, unknown>>) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pg = {
    async query<T>(sql: string, params?: unknown[]) {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes("FROM workspaces") && sql.includes("status = 'deleting'")) {
        return { rows: deletingRows as T[], rowCount: deletingRows.length };
      }
      return { rows: [] as T[], rowCount: 1 };
    },
  } as unknown as Queryable;
  return { pg, queries };
}

/* --------------------------- cancellation --------------------------- */

describe("cancelSubscriptionWithFinalInvoice", () => {
  it("cancels with a final invoice for accrued metered usage", async () => {
    const { stripe, cancels } = fakeStripe();
    const res = await cancelSubscriptionWithFinalInvoice("sub_1", { stripe });
    expect(res).toEqual({ canceled: true, alreadyGone: false });
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.id).toBe("sub_1");
    // invoice_now bills the usage sent before deletion; prorate:false = actual usage, not time-prorated.
    expect(cancels[0]!.params).toMatchObject({ invoice_now: true, prorate: false });
  });

  it("treats an already-canceled/missing subscription as done (idempotent retry)", async () => {
    const stripe = {
      subscriptions: {
        async cancel() {
          throw Object.assign(new Error("No such subscription: sub_x"), { code: "resource_missing", statusCode: 404 });
        },
      },
    } as unknown as Pick<Stripe, "subscriptions">;
    const res = await cancelSubscriptionWithFinalInvoice("sub_x", { stripe });
    expect(res).toEqual({ canceled: false, alreadyGone: true });
  });

  it("rethrows unexpected Stripe errors", async () => {
    const stripe = {
      subscriptions: {
        async cancel() {
          throw Object.assign(new Error("rate limited"), { code: "rate_limit", statusCode: 429 });
        },
      },
    } as unknown as Pick<Stripe, "subscriptions">;
    await expect(cancelSubscriptionWithFinalInvoice("sub_y", { stripe })).rejects.toThrow("rate limited");
  });
});

/* --------------------------- meter flush --------------------------- */

describe("flushWorkspaceMeterUsage", () => {
  it("reports one deduped inbound meter event per day and ignores deliveries", async () => {
    const { stripe, meterEvents } = fakeStripe();
    const ch = fakeCh({
      events: [
        { day: "2026-07-01", tasks: "100" },
        { day: "2026-07-07", tasks: "50" },
      ],
      delivery: [{ day: "2026-07-07", tasks: "50" }],
    });
    const res = await flushWorkspaceMeterUsage(
      { workspaceId: "ws_1", stripeCustomerId: "cus_1" },
      { stripe, ch, now: new Date("2026-07-07T14:00:00Z") },
    );

    expect(res.reported).toBe(2);
    const byId = Object.fromEntries(meterEvents.map((e) => [e.identifier, e]));
    // identifier matches the hourly cron's `${workspace}:${day}` so Stripe dedupes.
    expect(byId["ws_1:2026-07-01"]!.payload).toMatchObject({ stripe_customer_id: "cus_1", value: "100" });
    expect(byId["ws_1:2026-07-07"]!.payload).toMatchObject({ stripe_customer_id: "cus_1", value: "50" });
  });

  it("skips days with zero billable tasks", async () => {
    const { stripe, meterEvents } = fakeStripe();
    const ch = fakeCh({ events: [{ day: "2026-07-03", tasks: "0" }], delivery: [] });
    const res = await flushWorkspaceMeterUsage(
      { workspaceId: "ws_1", stripeCustomerId: "cus_1" },
      { stripe, ch, now: new Date("2026-07-07T14:00:00Z") },
    );
    expect(res.reported).toBe(0);
    expect(meterEvents).toHaveLength(0);
  });
});

/* --------------------------- sweep staging --------------------------- */

describe("sweepWorkspaceTeardowns billing stages", () => {
  const now = new Date("2026-07-07T14:00:00Z");

  it("stage 1: flushes usage and stamps usage_flushed_at, then waits", async () => {
    const { stripe, meterEvents, cancels } = fakeStripe();
    const ch = fakeCh({ events: [{ day: "2026-07-07", tasks: "12" }], delivery: [] });
    const { pg, queries } = fakePg([
      { id: "ws_1", plan: "pro", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", usage_flushed_at: null },
    ]);

    const { results } = await sweepWorkspaceTeardowns({ now, pg, stripe, wipeDeps: { clickhouse: ch } });

    expect(results).toEqual([{ workspaceId: "ws_1", stage: "flushed" }]);
    expect(meterEvents).toHaveLength(1); // usage reported before any wipe
    expect(cancels).toHaveLength(0); // NOT canceled yet — must settle first
    expect(queries.some((q) => q.sql.includes("usage_flushed_at = now()"))).toBe(true);
  });

  it("stage 2: within the settle window it holds off canceling", async () => {
    const { stripe, cancels } = fakeStripe();
    const { pg } = fakePg([
      {
        id: "ws_1",
        plan: "pro",
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        usage_flushed_at: new Date(now.getTime() - 30_000).toISOString(), // 30s ago < 2min
      },
    ]);
    const { results } = await sweepWorkspaceTeardowns({ now, pg, stripe });
    expect(results).toEqual([{ workspaceId: "ws_1", stage: "settling" }]);
    expect(cancels).toHaveLength(0);
  });

  it("reports large raw-payload cleanup as a successful resumable wiping stage", async () => {
    const { pg, queries } = fakePg([
      {
        id: "ws_large",
        plan: "free",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        usage_flushed_at: null,
      },
    ]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ workspace_id: "ws_large", deleted: 1_000, complete: false }),
    );

    const { results } = await sweepWorkspaceTeardowns({
      now,
      pg,
      wipeDeps: {
        fetchImpl,
        r2MaxBatches: 1,
        env: {
          INGEST_ADMIN_URL: "https://ingest.example",
          INGEST_ADMIN_TOKEN: "admin-token",
        },
      },
    });

    expect(results).toEqual([{
      workspaceId: "ws_large",
      stage: "wiping",
      detail: "Deleted 1000 raw payload object(s); more remain",
    }]);
    expect(queries.some((query) => query.sql.includes("DELETE FROM workspaces"))).toBe(false);
  });

  it("stops the sweep before the route-wide deadline instead of starting another teardown", async () => {
    const { pg, queries } = fakePg([
      {
        id: "ws_1",
        plan: "free",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        usage_flushed_at: null,
      },
      {
        id: "ws_2",
        plan: "free",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        usage_flushed_at: null,
      },
    ]);

    const result = await sweepWorkspaceTeardowns({ pg, deadlineMs: Date.now() });

    expect(result).toEqual({ swept: 0, results: [] });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("status = 'deleting'");
  });

  it.each([
    [
      "resource_missing",
      Object.assign(new Error("No such customer: 'cus_gone'"), {
        code: "resource_missing",
        param: "payload[stripe_customer_id]",
        statusCode: 400,
      }),
    ],
    [
      "404",
      Object.assign(new Error("No such customer: 'cus_gone'"), {
        statusCode: 404,
      }),
    ],
  ])("treats a missing Stripe customer (%s) as already gone and advances", async (_label, stripeError) => {
    const { pg, queries } = fakePg([
      {
        id: "ws_gone",
        plan: "pro",
        stripe_customer_id: "cus_gone",
        stripe_subscription_id: "sub_gone",
        usage_flushed_at: null,
      },
    ]);
    const stripe = {
      billing: {
        meterEvents: {
          async create() {
            throw stripeError;
          },
        },
      },
      subscriptions: { async cancel() {} },
    } as unknown as Pick<Stripe, "billing" | "subscriptions">;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const { results } = await sweepWorkspaceTeardowns({
        now,
        pg,
        stripe,
        wipeDeps: {
          clickhouse: fakeCh({ events: [{ day: "2026-07-07", tasks: "12" }] }),
        },
      });

      expect(results).toEqual([
        {
          workspaceId: "ws_gone",
          stage: "flushed",
          detail: "Stripe customer already deleted; skipped final usage flush",
        },
      ]);
      expect(queries.some((q) => q.sql.includes("usage_flushed_at = now()"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("finishes a mixed sweep, then rejects so the cron check-in and HTTP response fail", async () => {
    const { pg } = fakePg([
      {
        id: "ws_fail",
        plan: "pro",
        stripe_customer_id: "cus_fail",
        stripe_subscription_id: "sub_fail",
        usage_flushed_at: null,
      },
      {
        id: "ws_ok",
        plan: "pro",
        stripe_customer_id: "cus_ok",
        stripe_subscription_id: "sub_ok",
        usage_flushed_at: new Date(now.getTime() - 30_000).toISOString(),
      },
    ]);
    const stripe = {
      billing: {
        meterEvents: {
          async create() {
            throw Object.assign(new Error("No such meter: axel_tasks"), {
              code: "resource_missing",
              statusCode: 404,
            });
          },
        },
      },
      subscriptions: { async cancel() {} },
    } as unknown as Pick<Stripe, "billing" | "subscriptions">;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const promise = sweepWorkspaceTeardowns({
        now,
        pg,
        stripe,
        wipeDeps: { clickhouse: fakeCh({ events: [{ day: "2026-07-07", tasks: "1" }] }) },
      });

      await expect(promise).rejects.toMatchObject({
        name: "WorkspaceTeardownSweepError",
        summary: {
          swept: 2,
          results: [
            {
              workspaceId: "ws_fail",
              stage: "error",
              detail: "workspace_teardown_step_failed",
            },
            { workspaceId: "ws_ok", stage: "settling" },
          ],
        },
      } satisfies Partial<WorkspaceTeardownSweepError>);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("publicWorkspaceTeardownSweepSummary", () => {
  it("returns fixed stage counts without workspace IDs or error details", () => {
    const privateMarker = "private-workspace-provider-marker";
    const summary = publicWorkspaceTeardownSweepSummary({
      swept: 3,
      results: [
        { workspaceId: privateMarker, stage: "flushed", detail: privateMarker },
        { workspaceId: `${privateMarker}-2`, stage: "wiping", detail: privateMarker },
        { workspaceId: `${privateMarker}-3`, stage: "error", detail: privateMarker },
      ],
    });

    expect(summary.code).toBe("workspace_teardown_partial");
    expect(summary.stage_counts).toMatchObject({ flushed: 1, wiping: 1, error: 1 });
    expect(JSON.stringify(summary)).not.toContain(privateMarker);
    expect(summary).not.toHaveProperty("results");
  });
});

/* --------------------------- retry (single) --------------------------- */

describe("teardownSingleWorkspace", () => {
  it("returns a clear error (never throws) when the workspace is not in 'deleting'", async () => {
    const { pg } = fakePg([]); // the status='deleting' lookup finds nothing
    const res = await teardownSingleWorkspace("ws_missing", { pg });
    expect(res.stage).toBe("error");
    expect(res.workspaceId).toBe("ws_missing");
    expect(res.detail).toContain("deleting");
  });
});
