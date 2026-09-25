import { beforeEach, describe, expect, it, vi } from "vitest";
import { dismissIncidentAction, restoreIncidentAction } from "../lib/impact-alert-actions";

const mocks = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("../lib/db", () => ({
  db: () => ({ query: mocks.query }),
  withTransaction: (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
vi.mock("../lib/with-mutation", () => ({
  withWorkspaceMutation: (_options: unknown, fn: (context: unknown) => unknown) =>
    fn({ workspaceId: "ws_a", actorUserId: "user_a", audit: mocks.audit }),
}));

describe("ignore and close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(params[0]).toBe("ws_a");
      return { rowCount: sql.includes("RETURNING id") ? 1 : 0, rows: [] };
    });
  });

  it("hides the incident, cancels every queued email for it, and records who did it", async () => {
    expect(await dismissIncidentAction({ incidentId: "inc_a" })).toEqual({ ok: true });
    const [dismiss, cancel] = mocks.query.mock.calls as [[string, unknown[]], [string, unknown[]]];
    expect(dismiss[0]).toMatch(/SET dismissed_at = now\(\)/);
    expect(dismiss[0]).toMatch(/resolved_at IS NULL AND dismissed_at IS NULL/);
    expect(dismiss[1]).toEqual(["ws_a", "inc_a"]);
    expect(cancel[0]).toMatch(/alert_email_outbox SET state = 'cancelled'/);
    expect(cancel[0]).not.toMatch(/phase = 'reminder'/);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "incident.dismissed", targetId: "inc_a" }),
      expect.anything(),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/inbox");
  });

  it("reports an alert that already closed instead of pretending", async () => {
    mocks.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const result = await dismissIncidentAction({ incidentId: "inc_gone" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer active/i);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("brings an ignored alert back and re-arms its reminder", async () => {
    expect(await restoreIncidentAction({ incidentId: "inc_a" })).toEqual({ ok: true });
    const [restore] = mocks.query.mock.calls as [[string, unknown[]]];
    expect(restore[0]).toMatch(/dismissed_at = NULL/);
    expect(restore[0]).toMatch(/next_reminder_at = now\(\) \+ interval '24 hours'/);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "incident.restored" }), expect.anything());
  });

  it("never leaks a database failure", async () => {
    mocks.query.mockRejectedValue(new Error("connection to private-db.internal refused"));
    const result = await dismissIncidentAction({ incidentId: "inc_a" });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("private-db");
  });
});
