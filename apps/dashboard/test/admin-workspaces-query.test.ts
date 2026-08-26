import { beforeEach, describe, expect, it, vi } from "vitest";

// listAllWorkspaces runs a single multi-join SELECT via db(); capture the SQL
// and params so we can lock in the LIMIT/OFFSET contract (the /admin/workspaces
// page must never ship an unbounded payload — see listAllUsers /
// listAdminBillingWorkspaces for the sibling pattern).
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../lib/db", () => ({ db: () => ({ query: queryMock }) }));

import { listAllWorkspaces } from "../lib/admin-queries";

describe("listAllWorkspaces pagination", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("is bounded: the SQL carries LIMIT/OFFSET placeholders", async () => {
    await listAllWorkspaces();
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(sql).toMatch(/ORDER BY w\.created_at DESC/);
  });

  it("defaults to the first 100 rows, matching listAllUsers", async () => {
    await listAllWorkspaces();
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([100, 0]);
  });

  it("passes explicit limit/offset through for offset pagination", async () => {
    // The page fetches PAGE_SIZE + 1 rows to detect whether an older page
    // exists, so odd limits must survive untouched.
    await listAllWorkspaces(101, 200);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([101, 200]);
  });

  it("maps aggregate text counts to numbers", async () => {
    queryMock.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          id: "ws_1",
          name: "Acme",
          slug: "acme",
          status: "active",
          suspended_at: null,
          suspension_reason: null,
          created_at: "2026-01-01 00:00:00",
          owner_email: "owner@acme.test",
          member_count: "3",
          source_count: "2",
          destination_count: "5",
          billing_exempt: false,
        },
      ],
    });
    const rows = await listAllWorkspaces(1, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.member_count).toBe(3);
    expect(rows[0]?.source_count).toBe(2);
    expect(rows[0]?.destination_count).toBe(5);
  });
});
