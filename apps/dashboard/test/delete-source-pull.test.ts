import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSession } from "@axel/test-utils";

// deleteSource (lib/source-actions.ts) must delete BOTH the `sources` row AND the
// shared-id `pull_sources` row in one transaction — otherwise a deleted pull
// source keeps syncing + billing (audit: orphan pull source). Mock the edges so
// we can assert the second DELETE runs against the same transaction client.
const {
  sessionMock,
  withTransactionMock,
  dbQueryMock,
  invalidateEdgeMock,
  updateTagMock,
} = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  withTransactionMock: vi.fn(),
  dbQueryMock: vi.fn(),
  invalidateEdgeMock: vi.fn(),
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
  invalidateEdgeSourceCache: invalidateEdgeMock,
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

import { deleteSource } from "../lib/source-actions";

function ownerSession() {
  return fakeSession("owner", { user: { id: "usr_owner" } });
}

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.append(k, v);
  return f;
}

describe("deleteSource — also deletes the shared-id pull_sources row", () => {
  afterEach(() => vi.clearAllMocks());

  it("deletes both sources and pull_sources in one transaction", async () => {
    sessionMock.mockResolvedValue(ownerSession());
    invalidateEdgeMock.mockResolvedValue(undefined);

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
    // The audit-log INSERT runs on db() after the transaction.
    dbQueryMock.mockResolvedValue({ rowCount: 1, rows: [] });

    const result = await deleteSource({}, fd({ source_id: "src_pull_1" }));

    expect(result.notice).toMatch(/deleted/i);
    const deletes = clientQueries.filter((q) => /^DELETE/i.test(q.sql.trim()));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.sql).toMatch(/DELETE FROM sources/i);
    expect(deletes[1]!.sql).toMatch(/DELETE FROM pull_sources/i);
    // Both scoped to (id, workspace_id).
    expect(deletes[0]!.params).toEqual(["src_pull_1", "ws_1"]);
    expect(deletes[1]!.params).toEqual(["src_pull_1", "ws_1"]);
  });

  it("returns not-found and skips pull_sources delete when the source row is absent", async () => {
    sessionMock.mockResolvedValue(ownerSession());

    const clientQueries: string[] = [];
    const fakeClient = {
      query: vi.fn(async (sql: string) => {
        clientQueries.push(sql);
        if (/DELETE FROM sources/i.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      }),
    };
    withTransactionMock.mockImplementation(async (fn: (c: typeof fakeClient) => Promise<unknown>) => fn(fakeClient));

    const result = await deleteSource({}, fd({ source_id: "missing" }));

    expect(result.error).toMatch(/not found/i);
    expect(clientQueries.some((s) => /DELETE FROM pull_sources/i.test(s))).toBe(false);
  });
});
