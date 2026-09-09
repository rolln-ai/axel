import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSession } from "@axel/test-utils";

// deleteSource (lib/source-actions.ts) must delete BOTH the `sources` row AND the
// shared-id `pull_sources` row in one transaction — otherwise a deleted pull
// source keeps syncing + billing (audit: orphan pull source). Mock the edges so
// we can assert the second DELETE runs against the same transaction client.
const {
  sessionMock,
  withTransactionMock,
  dbQueryMock,
  fenceEdgeMock,
  syncEdgeMock,
  updateTagMock,
} = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  withTransactionMock: vi.fn(),
  dbQueryMock: vi.fn(),
  fenceEdgeMock: vi.fn(),
  syncEdgeMock: vi.fn(),
  updateTagMock: vi.fn(),
}));

vi.mock("../lib/session", () => ({
  requireSession: sessionMock,
  // unused by deleteSource but imported at module scope
  createSession: vi.fn(),
  destroySession: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
}));
vi.mock("../lib/db", () => ({
  db: () => ({ query: dbQueryMock }),
  withTransaction: withTransactionMock,
}));
vi.mock("../lib/edge-invalidation", () => ({
  requireEdgeSourceFence: fenceEdgeMock,
  requireEdgeSourceAuthoritySync: syncEdgeMock,
  pushSourceToEdge: vi.fn(),
  loadSourceForEdge: vi.fn(),
  rowToEdgePayload: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: updateTagMock,
}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { deleteSource, rotateSourceToken, updateSourceUrlToken, setSourceStatus } from "../lib/source-actions";

function ownerSession() {
  return fakeSession("owner", { user: { id: "usr_owner" } });
}

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.append(k, v);
  return f;
}

describe("source revocation authority sequencing", () => {
  beforeEach(() => {
    fenceEdgeMock.mockImplementation(async (sourceId: string) => ({
      sourceId,
      fenceToken: "fence_token_00000001",
    }));
    syncEdgeMock.mockResolvedValue(undefined);
    dbQueryMock.mockImplementation(async (sql: string) => ({
      rowCount: 1,
      rows: /FROM workspaces/i.test(sql) ? [{ status: "active" }] : [],
    }));
    withTransactionMock.mockImplementation(async (fn: (client: { query: typeof dbQueryMock }) => Promise<unknown>) => (
      fn({ query: dbQueryMock })
    ));
  });
  afterEach(() => vi.clearAllMocks());

  it("deletes both sources and pull_sources in one transaction", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
    const fakeClient = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        clientQueries.push({ sql, params });
        // The first DELETE (sources) must report a deleted row.
        if (/DELETE FROM sources/i.test(sql)) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      }),
    };
    withTransactionMock.mockImplementation(async (fn: (c: typeof fakeClient) => Promise<unknown>) => fn(fakeClient));
    // The audit-log INSERT shares the delete transaction.
    const result = await deleteSource({}, fd({ source_id: "src_pull_1" }));

    expect(result.notice).toMatch(/deleted/i);
    const deletes = clientQueries.filter((q) => /^DELETE/i.test(q.sql.trim()));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.sql).toMatch(/DELETE FROM sources/i);
    expect(deletes[1]!.sql).toMatch(/DELETE FROM pull_sources/i);
    // Both scoped to (id, workspace_id).
    expect(deletes[0]!.params).toEqual(["src_pull_1", "ws_1"]);
    expect(deletes[1]!.params).toEqual(["src_pull_1", "ws_1"]);
    expect(fenceEdgeMock).toHaveBeenCalledOnce();
    expect(fenceEdgeMock).toHaveBeenCalledWith("src_pull_1");
    expect(syncEdgeMock).toHaveBeenCalledWith(
      { sourceId: "src_pull_1", fenceToken: "fence_token_00000001" },
      "ws_1",
    );
  });

  it("returns not-found and skips pull_sources delete when the source row is absent", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    dbQueryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await deleteSource({}, fd({ source_id: "missing" }));

    expect(result.error).toMatch(/not found/i);
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(fenceEdgeMock).not.toHaveBeenCalled();
    expect(syncEdgeMock).not.toHaveBeenCalled();
  });

  it("retries edge deletion for a source whose database delete was already audited", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    dbQueryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] });

    const result = await deleteSource({}, fd({ source_id: "src_deleted" }));

    expect(result.notice).toMatch(/already deleted/i);
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(fenceEdgeMock).toHaveBeenCalledOnce();
    expect(fenceEdgeMock).toHaveBeenCalledWith("src_deleted");
    expect(syncEdgeMock).toHaveBeenCalledOnce();
  });

  it("does not delete Postgres rows when required edge invalidation fails", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    fenceEdgeMock.mockRejectedValueOnce(new Error("edge unavailable"));

    await expect(deleteSource({}, fd({ source_id: "src_pull_1" })))
      .rejects.toThrow("edge unavailable");

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(dbQueryMock).toHaveBeenCalledOnce();
    expect(String(dbQueryMock.mock.calls[0]?.[0])).toMatch(/SELECT 1 FROM sources/i);
  });

  it("fences before disabling and syncs committed state afterward", async () => {
    sessionMock.mockResolvedValue(ownerSession());

    const result = await setSourceStatus({}, fd({ source_id: "src_1", status: "disabled" }));

    expect(result.notice).toMatch(/disabled/i);
    expect(fenceEdgeMock).toHaveBeenCalledOnce();
    expect(syncEdgeMock).toHaveBeenCalledOnce();
    const updateIndex = dbQueryMock.mock.calls.findIndex((call) => /UPDATE sources/i.test(String(call[0])));
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    const updateOrder = dbQueryMock.mock.invocationCallOrder[updateIndex]!;
    expect(fenceEdgeMock.mock.invocationCallOrder[0]).toBeLessThan(updateOrder);
    expect(syncEdgeMock.mock.invocationCallOrder[0]).toBeGreaterThan(updateOrder);
  });

  it("fences and syncs when enabling a source", async () => {
    sessionMock.mockResolvedValue(ownerSession());

    const result = await setSourceStatus({}, fd({ source_id: "src_1", status: "active" }));

    expect(result.notice).toMatch(/enabled/i);
    expect(fenceEdgeMock).toHaveBeenCalledWith("src_1");
    expect(syncEdgeMock).toHaveBeenCalledOnce();
    const sql = dbQueryMock.mock.calls.map(([statement]) => String(statement));
    const lockIndex = sql.findIndex((statement) => /FROM workspaces[\s\S]*FOR UPDATE/i.test(statement));
    const updateIndex = sql.findIndex((statement) => /UPDATE sources/i.test(statement));
    expect(withTransactionMock).toHaveBeenCalledOnce();
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(lockIndex);
  });

  it("does not re-enable a source when suspension wins the workspace lock", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    dbQueryMock.mockImplementation(async (sql: string) => ({
      rowCount: 1,
      rows: /FROM workspaces/i.test(sql) ? [{ status: "suspended" }] : [],
    }));

    const result = await setSourceStatus({}, fd({ source_id: "src_1", status: "active" }));

    expect(result.error).toMatch(/no longer active/i);
    expect(dbQueryMock.mock.calls.some(([sql]) => /UPDATE sources/i.test(String(sql)))).toBe(false);
    expect(fenceEdgeMock).toHaveBeenCalledOnce();
    expect(syncEdgeMock).toHaveBeenCalledOnce();
  });

  it("fences before rotating a token and syncs afterward", async () => {
    sessionMock.mockResolvedValue(ownerSession());

    const result = await rotateSourceToken({}, fd({ source_id: "src_1" }));

    expect(result.data?.plaintextToken).toEqual(expect.any(String));
    expect(fenceEdgeMock).toHaveBeenCalledOnce();
    expect(syncEdgeMock).toHaveBeenCalledOnce();
    const updateIndex = dbQueryMock.mock.calls.findIndex((call) => /secret_token_hash/i.test(String(call[0])));
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    const updateOrder = dbQueryMock.mock.invocationCallOrder[updateIndex]!;
    expect(fenceEdgeMock.mock.invocationCallOrder[0]).toBeLessThan(updateOrder);
    expect(syncEdgeMock.mock.invocationCallOrder[0]).toBeGreaterThan(updateOrder);
  });
  it("generates a separate URL credential after fencing and returns it only after sync", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    const result = await updateSourceUrlToken({}, fd({ source_id: "src_1", operation: "generate" }));
    const token = result.data?.plaintextUrlToken;
    expect(token).toMatch(/^axu_[A-Za-z0-9_-]{43}$/);
    expect(result.data?.urlTokenEnabled).toBe(true);
    const index = dbQueryMock.mock.calls.findIndex(([sql]) => /UPDATE sources/.test(String(sql)));
    const [sql, values] = dbQueryMock.mock.calls[index]!;
    expect(sql).not.toContain("secret_token_hash");
    expect(values).toEqual([createHash("sha256").update(token!).digest("hex"), "src_1", "ws_1"]);
    expect(JSON.stringify(dbQueryMock.mock.calls)).not.toContain(token);
    expect(fenceEdgeMock.mock.invocationCallOrder[0]).toBeLessThan(dbQueryMock.mock.invocationCallOrder[index]!);
    expect(syncEdgeMock.mock.invocationCallOrder[0]).toBeGreaterThan(dbQueryMock.mock.invocationCallOrder[index]!);
    expect(withTransactionMock).toHaveBeenCalledOnce();
  });

  it("disables the URL credential without returning an old secret", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    const result = await updateSourceUrlToken({}, fd({ source_id: "src_1", operation: "disable" }));
    expect(result.data).toEqual({ sourceId: "src_1", urlTokenEnabled: false });
    const [sql, values] = dbQueryMock.mock.calls.find(([sql]) => /UPDATE sources/.test(String(sql)))!;
    expect(sql).not.toContain("secret_token_hash");
    expect(values).toEqual([null, "src_1", "ws_1"]);
    expect(fenceEdgeMock).toHaveBeenCalledOnce();
    expect(syncEdgeMock).toHaveBeenCalledOnce();
  });

  it("denies URL credential changes by members", async () => {
    sessionMock.mockResolvedValue(fakeSession("member"));
    const result = await updateSourceUrlToken({}, fd({ source_id: "src_1", operation: "generate" }));
    expect(result.error).toBeTruthy();
    expect(dbQueryMock).not.toHaveBeenCalled();
    expect(fenceEdgeMock).not.toHaveBeenCalled();
  });

  it("does not fence a foreign, named-provider, or pull source", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    dbQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await updateSourceUrlToken({}, fd({ source_id: "src_foreign", operation: "generate" }));
    expect(result.error).toMatch(/not found/);
    expect(dbQueryMock.mock.calls[0]?.[1]).toEqual(["src_foreign", "ws_1"]);
    expect(fenceEdgeMock).not.toHaveBeenCalled();
  });

  it("cannot add a URL credential when suspension wins the workspace lock", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    dbQueryMock.mockImplementation(async (sql: string) => ({ rowCount: 1, rows: /FROM workspaces/.test(sql) ? [{ status: "suspended" }] : [] }));
    const result = await updateSourceUrlToken({}, fd({ source_id: "src_1", operation: "generate" }));
    expect(result.error).toBeTruthy();
    expect(dbQueryMock.mock.calls.some(([sql]) => /UPDATE sources/.test(String(sql)))).toBe(false);
  });

  it("does not mutate when fencing fails or report success when sync fails", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    fenceEdgeMock.mockRejectedValueOnce(new Error("fence unavailable"));
    await expect(updateSourceUrlToken({}, fd({ source_id: "src_1", operation: "generate" }))).rejects.toThrow("fence unavailable");
    expect(withTransactionMock).not.toHaveBeenCalled();
    syncEdgeMock.mockRejectedValueOnce(new Error("sync unavailable"));
    await expect(updateSourceUrlToken({}, fd({ source_id: "src_1", operation: "generate" }))).rejects.toThrow("sync unavailable");
  });

});
