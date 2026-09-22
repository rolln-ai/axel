import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixIncidentAction } from "../lib/incident-fix-actions";

const mocks = vi.hoisted(() => ({ query: vi.fn(), enqueue: vi.fn(), repair: vi.fn(), audit: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/db", () => ({
  db: () => ({ query: mocks.query }),
  withTransaction: (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
vi.mock("../lib/with-mutation", () => ({
  withWorkspaceMutation: (_options: unknown, fn: (context: unknown) => unknown) =>
    fn({ workspaceId: "ws_a", actorUserId: "user_a", audit: mocks.audit }),
}));
vi.mock("../lib/replay-enqueue", () => ({ enqueueReplays: mocks.enqueue, bustReplayTags: vi.fn() }));
vi.mock("../lib/impact-alert-health", () => ({ loadImpactObservations: vi.fn() }));
vi.mock("../lib/impact-alerts", () => ({ recordImpactObservations: vi.fn() }));
vi.mock("../lib/dead-letter-repair", () => ({ dataTypeRepairFor: mocks.repair }));
vi.mock("../lib/inbox", () => ({ fingerprintFor: vi.fn() }));
vi.mock("../lib/inbox-actions", () => ({
  applyFingerprintRepair: vi.fn(), applyFingerprintSchemaRepair: vi.fn(), previewFingerprintRepair: vi.fn(),
}));

describe("incident fixes use current delivery controls", () => {
  const destination = { status: "active", delivery_paused: false, circuit_state: "closed" };
  let cause: string;
  let routeStatus: string | null;
  let controls: typeof destination | null;

  beforeEach(() => {
    vi.clearAllMocks();
    cause = "destination_paused";
    routeStatus = "active";
    controls = { ...destination };
    mocks.enqueue.mockResolvedValue({ queued: 2, jobId: "job_a" });
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(params[0]).toBe("ws_a");
      if (sql.includes("SELECT id, kind, snapshot")) return { rows: [{ id: "inc_a", kind: "delivery_blocked",
        snapshot: { sourceId: "src_a", routeId: "rt_a", destinationId: "dst_a", cause } }] };
      if (sql.includes("SELECT status FROM routes")) {
        expect(params).toEqual(["ws_a", "rt_a", "src_a"]);
        return { rows: routeStatus === null ? [] : [{ status: routeStatus }] };
      }
      if (sql.includes("FROM destinations d")) {
        expect(params).toEqual(["ws_a", "dst_a", "rt_a"]);
        return { rows: controls ? [controls] : [] };
      }
      return { rows: [] };
    });
  });

  it.each(["destination_paused", "route_errored"])("replays after recovery even when the alert still says %s", async (snapshotCause) => {
    cause = snapshotCause;
    expect(await fixIncidentAction({ incidentId: "inc_a" })).toMatchObject({ ok: true, queued: 2 });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    ["errored", /route stopped after a processing error/i],
    ["disabled", /route is disabled/i],
    [null, /route is no longer available/i],
  ])("blocks a %s route before repair or replay", async (status, message) => {
    routeStatus = status;
    const result = await fixIncidentAction({ incidentId: "inc_a" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(message);
    expect(result.error).not.toMatch(/destination.*paused/i);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...destination, delivery_paused: true }, /delivery.*paused/i],
    [{ ...destination, status: "disabled" }, /destination is disabled/i],
    [{ ...destination, circuit_state: "disabled" }, /destination is disabled/i],
    [{ ...destination, circuit_state: "open" }, /circuit breaker is open/i],
    [null, /destination is no longer available/i],
  ])("blocks current destination controls even with an older failure alert: %j", async (state, message) => {
    cause = "schema_mismatch";
    controls = state;
    const result = await fixIncidentAction({ incidentId: "inc_a" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(message);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("allows the delivery worker to probe a half-open breaker", async () => {
    controls!.circuit_state = "half_open";
    expect(await fixIncidentAction({ incidentId: "inc_a" })).toMatchObject({ ok: true, queued: 2 });
  });

  it("never repairs or replays when current controls cannot be read", async () => {
    mocks.query.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(fixIncidentAction({ incidentId: "inc_a" })).rejects.toThrow("Database unavailable");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });
});
