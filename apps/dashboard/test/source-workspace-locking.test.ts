import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  auditMock,
  flushAllMock,
  invalidateAllMock,
  wipeMock,
  withTransactionMock,
} = vi.hoisted(() => ({
  auditMock: vi.fn(),
  flushAllMock: vi.fn(),
  invalidateAllMock: vi.fn(),
  wipeMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: () => ({ query: vi.fn() }),
  withTransaction: withTransactionMock,
}));
vi.mock("../lib/edge-invalidation", () => ({
  requireEdgeSourceCacheInvalidations: invalidateAllMock,
}));
vi.mock("../lib/repositories", () => ({
  bustWorkspaceTags: vi.fn(),
}));
vi.mock("../lib/session", () => ({
  setActiveWorkspaceId: vi.fn(),
}));
vi.mock("../lib/with-mutation", () => ({
  withWorkspaceMutation: async (
    _options: unknown,
    fn: (ctx: unknown) => Promise<unknown>,
  ) => fn({
    session: {
      user: { id: "usr_owner" },
      activeWorkspace: {
        workspace_id: "ws_1",
        workspace_name: "Workspace",
        workspace_status: "active",
        role: "owner",
      },
      memberships: [],
    },
    workspaceId: "ws_1",
    actorUserId: "usr_owner",
    audit: auditMock,
    tags: vi.fn(),
  }),
}));
vi.mock("../lib/data-reset", () => ({
  flushAllDestinationData: flushAllMock,
  flushDestinationData: vi.fn(),
  wipeWorkspaceData: wipeMock,
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { wipeAllWorkspaceData } from "../lib/danger-zone-actions";

function wipeForm(): FormData {
  const form = new FormData();
  form.set("confirmation", "wipe all");
  return form;
}

describe("workspace source-lock invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAllMock.mockResolvedValue(undefined);
    auditMock.mockResolvedValue(undefined);
    flushAllMock.mockResolvedValue({ attempted: 0, flushed: [], skipped: [], failed: [] });
    wipeMock.mockResolvedValue({
      clickhouseTables: [],
      postgresRows: 0,
      r2Deleted: 0,
      r2Skipped: false,
      r2LimitReached: false,
      postgresLimitReached: false,
      clickhouseLimitReached: false,
    });
  });

  it("locks and rechecks the workspace before enumerating and disabling sources", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/FROM workspaces/i.test(sql)) return { rows: [{ status: "active" }], rowCount: 1 };
        if (/SELECT id FROM sources/i.test(sql)) {
          return { rows: [{ id: "src_1" }, { id: "src_2" }], rowCount: 2 };
        }
        return { rows: [{ id: "src_1" }, { id: "src_2" }], rowCount: 2 };
      }),
    };
    withTransactionMock.mockImplementation(async (fn: (value: typeof client) => Promise<unknown>) => fn(client));

    const result = await wipeAllWorkspaceData({}, wipeForm());

    expect(result.notice).toMatch(/Paused 2 sources/i);
    const sql = client.query.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toMatch(/FROM workspaces[\s\S]*FOR UPDATE/i);
    expect(sql[1]).toMatch(/SELECT id FROM sources/i);
    expect(sql[2]).toMatch(/UPDATE sources/i);
    expect(invalidateAllMock).toHaveBeenNthCalledWith(1, ["src_1", "src_2"]);
    expect(invalidateAllMock).toHaveBeenNthCalledWith(2, ["src_1", "src_2"]);
  });

  it("does not enumerate, disable, or wipe after a locked inactive status", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ status: "suspended" }], rowCount: 1 })),
    };
    withTransactionMock.mockImplementation(async (fn: (value: typeof client) => Promise<unknown>) => fn(client));

    const result = await wipeAllWorkspaceData({}, wipeForm());

    expect(result.error).toBe("workspace_not_active");
    expect(client.query).toHaveBeenCalledOnce();
    expect(invalidateAllMock).not.toHaveBeenCalled();
    expect(flushAllMock).not.toHaveBeenCalled();
    expect(wipeMock).not.toHaveBeenCalled();
  });
});
