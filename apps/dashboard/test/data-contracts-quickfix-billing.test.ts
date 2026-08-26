import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSession } from "@axel/test-utils";

// quickFixWithAiAction is a server-action wrapper: it calls requireSession()
// then the shared replay guards (requireActiveWorkspace + replayBillingGateError)
// BEFORE it ever queries dead_letters or enqueues replays. Mock those edges so we
// can assert the gates short-circuit and no DB replay work happens.
const { sessionMock, dbQueryMock, requireActiveWorkspaceMock, billingGateMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  dbQueryMock: vi.fn(),
  requireActiveWorkspaceMock: vi.fn(),
  billingGateMock: vi.fn(),
}));

vi.mock("../lib/session", () => ({
  requireSession: sessionMock,
}));
vi.mock("../lib/db", () => ({
  db: () => ({ query: dbQueryMock }),
}));
vi.mock("../lib/auth-guards", () => ({
  requireActiveWorkspace: requireActiveWorkspaceMock,
  replayBillingGateError: billingGateMock,
  // Real-shaped role gate so the member-rejection case exercises the shared copy.
  requireWritableRole: (role: string) =>
    role === "owner" || role === "admin"
      ? null
      : "Only owners and admins can make changes in this workspace.",
}));

import { quickFixWithAiAction } from "../lib/data-contracts/actions";

function ownerSession() {
  return fakeSession("owner", { user: { id: "usr_owner" } });
}

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.append(k, v);
  return f;
}

describe("quickFixWithAiAction — billing + active-workspace gate (audit fix)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("blocks a suspended workspace before any replay work", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    requireActiveWorkspaceMock.mockReturnValue("This workspace is suspended. Contact support to restore it.");
    billingGateMock.mockResolvedValue(null);

    const result = await quickFixWithAiAction({}, fd({ reason: "declarative_engine_error" }));

    expect(result.error).toMatch(/suspended/i);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("blocks an over-quota / billing-suspended workspace before any replay work", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    requireActiveWorkspaceMock.mockReturnValue(null);
    billingGateMock.mockResolvedValue("This workspace has hit its monthly free-tier limit. Replays are paused until usage resets or you upgrade.");

    const result = await quickFixWithAiAction({}, fd({ reason: "declarative_engine_error" }));

    expect(result.error).toMatch(/free-tier limit|billing/i);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("still rejects non-owner/admin roles before the gate runs", async () => {
    sessionMock.mockResolvedValue({
      user: { id: "u1" },
      activeWorkspace: { workspace_id: "ws_1", role: "member", workspace_status: "active" },
    });

    const result = await quickFixWithAiAction({}, fd({ reason: "declarative_engine_error" }));

    expect(result.error).toMatch(/owners and admins/i);
    expect(billingGateMock).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("passes both gates and proceeds (then bails on missing data, not on the gate)", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    requireActiveWorkspaceMock.mockReturnValue(null);
    billingGateMock.mockResolvedValue(null);
    // First query is the seed dead_letter lookup → return none so the action
    // exits cleanly past the gates without needing R2 / AI / replay plumbing.
    dbQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await quickFixWithAiAction({}, fd({ reason: "declarative_engine_error" }));

    expect(billingGateMock).toHaveBeenCalledWith("ws_1");
    expect(result.notice).toMatch(/no unresolved failures/i);
  });
});
