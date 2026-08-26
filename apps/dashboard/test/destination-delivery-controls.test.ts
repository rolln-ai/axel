import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturingPg, fakeSession } from "@axel/test-utils";

// Style B (module mock, same shape as replay-bulk-mute.test.ts): exercise
// destinationDeliveryControlsAction against a scripted fake { query },
// locking the rowCount-honesty fix (audit finding
// ux-destinations::delivery-controls-false-success-on-missing-row): a
// zero-row UPDATE — destination deleted between page load and submit —
// must report an error, never "controls applied".

const pg = capturingPg();
const { calls: pgCalls, responses: pgResponses } = pg;

const sessionState = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "member",
}));

vi.mock("../lib/db", () => pg.dbModule());

vi.mock("../lib/session", () => ({
  requireSession: async () => fakeSession(sessionState.role),
}));

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Map(),
  cookies: async () => ({ get: () => undefined }),
}));

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("destinationDeliveryControlsAction — rowCount honesty", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
    sessionState.role = "owner";
  });

  it("rejects members before touching the database", async () => {
    sessionState.role = "member";
    const { destinationDeliveryControlsAction } = await import("../lib/destination-actions");
    const result = await destinationDeliveryControlsAction(
      {},
      formData({ destination_id: "dst_1", action: "pause" }),
    );
    expect(result.error).toMatch(/only owners and admins/i);
    expect(pgCalls).toHaveLength(0);
  });

  it("pause: zero-row UPDATE reports 'not found', no success notice, no audit row", async () => {
    pgResponses.push({ rows: [], rowCount: 0 }); // UPDATE hits nothing

    const { destinationDeliveryControlsAction } = await import("../lib/destination-actions");
    const result = await destinationDeliveryControlsAction(
      {},
      formData({ destination_id: "dst_gone", action: "pause", reason: "maintenance" }),
    );

    expect(result.error).toMatch(/not found in this workspace/i);
    expect(result.notice).toBeUndefined();
    expect(pgCalls.some((c) => /INSERT INTO audit_log/.test(c.sql))).toBe(false);
  });

  it("resume: zero-row UPDATE reports 'not found'", async () => {
    pgResponses.push({ rows: [], rowCount: 0 });

    const { destinationDeliveryControlsAction } = await import("../lib/destination-actions");
    const result = await destinationDeliveryControlsAction(
      {},
      formData({ destination_id: "dst_gone", action: "resume" }),
    );

    expect(result.error).toMatch(/not found in this workspace/i);
    expect(result.notice).toBeUndefined();
  });

  it("update_controls: zero-row UPDATE reports 'not found'", async () => {
    pgResponses.push({ rows: [], rowCount: 0 });

    const { destinationDeliveryControlsAction } = await import("../lib/destination-actions");
    const result = await destinationDeliveryControlsAction(
      {},
      formData({
        destination_id: "dst_gone",
        action: "update_controls",
        rate_limit_rps: "10",
        request_timeout_ms: "5000",
      }),
    );

    expect(result.error).toMatch(/not found in this workspace/i);
    expect(result.notice).toBeUndefined();
  });

  it("pause: one-row UPDATE still succeeds and writes the audit row", async () => {
    pgResponses.push({ rows: [], rowCount: 1 }); // UPDATE destinations
    pgResponses.push({ rows: [], rowCount: 1 }); // INSERT audit_log

    const { destinationDeliveryControlsAction } = await import("../lib/destination-actions");
    const result = await destinationDeliveryControlsAction(
      {},
      formData({ destination_id: "dst_1", action: "pause", reason: "maintenance" }),
    );

    expect(result.error).toBeUndefined();
    expect(result.notice).toMatch(/pause applied/i);
    expect(pgCalls.some((c) => /INSERT INTO audit_log/.test(c.sql))).toBe(true);
  });
});
