import { beforeEach, describe, expect, it, vi } from "vitest";

// withWorkspaceMutation is THE guard spine: role gate → workspace-status gate
// → (opt-in) billing gate, in that fixed order, with workspace-bound audit()
// and tags() helpers exposed to the callback. These tests pin the ordering —
// the whole point of the wrapper is that a gate can no longer be dropped or
// reordered per-action.

const { sessionState, billingMock, updateTagMock, dbQueryMock } = vi.hoisted(() => ({
  sessionState: {
    session: {
      user: { id: "usr_1" },
      activeWorkspace: {
        workspace_id: "ws_1",
        role: "owner" as "owner" | "admin" | "member",
        workspace_status: "active" as "active" | "suspended" | "deleted",
      },
    },
  },
  billingMock: vi.fn(async () => null as string | null),
  updateTagMock: vi.fn(),
  dbQueryMock: vi.fn(async () => ({ rows: [], rowCount: 1 })),
}));

vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => sessionState.session),
}));

vi.mock("../lib/db", () => ({
  db: () => ({ query: dbQueryMock }),
}));

// Keep the REAL role/status predicates (they're pure); only the billing gate
// dials the database, so replace just computePlanState's consumer.
vi.mock("../lib/billing/plan-state", () => ({
  computePlanState: vi.fn(async () => null),
}));

vi.mock("next/cache", () => ({
  updateTag: updateTagMock,
  unstable_cache: (fn: unknown) => fn,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("../lib/auth-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth-guards")>();
  return { ...actual, replayBillingGateError: billingMock };
});

import { withWorkspaceMutation } from "../lib/with-mutation";

function setSession(over: Partial<{ role: "owner" | "admin" | "member"; status: "active" | "suspended" | "deleted" }>) {
  sessionState.session = {
    user: { id: "usr_1" },
    activeWorkspace: {
      workspace_id: "ws_1",
      role: over.role ?? "owner",
      workspace_status: over.status ?? "active",
    },
  };
}

describe("withWorkspaceMutation — gate ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSession({});
    billingMock.mockResolvedValue(null);
  });

  it("runs the callback with workspace identity when all gates pass", async () => {
    const fn = vi.fn(async ({ workspaceId, actorUserId }) => ({ notice: `${workspaceId}/${actorUserId}` }));
    const result = await withWorkspaceMutation({}, fn);
    expect(result).toEqual({ notice: "ws_1/usr_1" });
  });

  it("rejects members BEFORE the workspace-status gate (role error wins in a suspended workspace)", async () => {
    setSession({ role: "member", status: "suspended" });
    const fn = vi.fn();
    const result = await withWorkspaceMutation({}, fn as never);
    expect((result as { error?: string }).error).toMatch(/owners and admins/i);
    expect(fn).not.toHaveBeenCalled();
    expect(billingMock).not.toHaveBeenCalled();
  });

  it("rejects a suspended workspace for owners — the status gate is NOT optional", async () => {
    setSession({ role: "owner", status: "suspended" });
    const result = await withWorkspaceMutation({}, async () => ({ notice: "nope" }));
    expect((result as { error?: string }).error).toMatch(/suspended/i);
    expect(billingMock).not.toHaveBeenCalled();
  });

  it('role: "any" skips the role gate but never the status gate', async () => {
    setSession({ role: "member", status: "active" });
    const ok = await withWorkspaceMutation({ role: "any" }, async () => ({ notice: "ran" }));
    expect(ok).toEqual({ notice: "ran" });

    setSession({ role: "member", status: "deleted" });
    const blocked = await withWorkspaceMutation({ role: "any" }, async () => ({ notice: "ran" }));
    expect((blocked as { error?: string }).error).toMatch(/no longer available/i);
  });

  it('billing: "replay" runs AFTER role + status and blocks on a gate message', async () => {
    billingMock.mockResolvedValue("Billing is suspended for this workspace.");
    const fn = vi.fn();
    const result = await withWorkspaceMutation({ billing: "replay" }, fn as never);
    expect((result as { error?: string }).error).toMatch(/billing is suspended/i);
    expect(billingMock).toHaveBeenCalledWith("ws_1");
    expect(fn).not.toHaveBeenCalled();

    // A member never reaches the billing gate.
    billingMock.mockClear();
    setSession({ role: "member" });
    await withWorkspaceMutation({ billing: "replay" }, fn as never);
    expect(billingMock).not.toHaveBeenCalled();
  });

  it("does not run the billing gate unless opted in", async () => {
    await withWorkspaceMutation({}, async () => ({ notice: "ok" }));
    expect(billingMock).not.toHaveBeenCalled();
  });

  it("maps gate rejections through gateError for non-ActionState envelopes", async () => {
    setSession({ role: "member" });
    type ProbeResult = { ok: boolean; severity: "fail" | "pass"; message: string };
    const result = await withWorkspaceMutation<ProbeResult>(
      { gateError: (message) => ({ ok: false, severity: "fail", message }) },
      async () => ({ ok: true, severity: "pass", message: "" }),
    );
    expect(result).toMatchObject({ ok: false, severity: "fail" });
    expect(result.message).toMatch(/owners and admins/i);
  });

  it("audit() pre-fills the workspace + actor and writes one canonical row", async () => {
    await withWorkspaceMutation({}, async ({ audit }) => {
      await audit({ action: "thing.done", targetType: "thing", targetId: "t1", metadata: { a: 1 } });
      return { notice: "ok" };
    });
    expect(dbQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = dbQueryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO audit_log/);
    expect(params).toEqual(["ws_1", "usr_1", "thing.done", "thing", "t1", JSON.stringify({ a: 1 })]);
  });

  it("audit() uses the provided transaction client when given one", async () => {
    const txQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    await withWorkspaceMutation({}, async ({ audit }) => {
      await audit(
        { action: "thing.done", targetType: "thing", targetId: "t1" },
        { query: txQuery } as never,
      );
      return { notice: "ok" };
    });
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("tags() busts the named per-workspace tag families", async () => {
    await withWorkspaceMutation({}, async ({ tags }) => {
      tags("sources", "routes");
      return { notice: "ok" };
    });
    expect(updateTagMock.mock.calls.map((c) => c[0])).toEqual(["ws-ws_1-sources", "ws-ws_1-routes"]);
  });
});
