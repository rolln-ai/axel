import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateApiKey, scopeAllows, type ApiKeyAuthContext } from "../lib/api-keys";

// authenticateApiKey runs two db() queries: the SELECT (now JOINing workspaces)
// and a fire-and-forget last_used_at UPDATE. hoist the mock so the hoisted
// vi.mock factory can reference it.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../lib/db", () => ({ db: () => ({ query: queryMock }) }));

function selectReturns(row: Record<string, unknown> | null): void {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/SELECT[\s\S]*workspace_api_keys/i.test(sql)) {
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 }; // last_used_at UPDATE
  });
}

const activeRow = {
  id: "key_1",
  workspace_id: "ws_1",
  scopes: ["admin"],
  revoked_at: null,
  workspace_status: "active",
};

function ctx(scopes: ApiKeyAuthContext["scopes"]): ApiKeyAuthContext {
  return { workspace_id: "ws-1", key_id: "k-1", scopes };
}

describe("scopeAllows (AXE-29)", () => {
  it("read scope grants read", () => {
    expect(scopeAllows(ctx(["read"]), "read")).toBe(true);
  });

  it("read scope does not grant write / replay / admin", () => {
    expect(scopeAllows(ctx(["read"]), "write")).toBe(false);
    expect(scopeAllows(ctx(["read"]), "replay")).toBe(false);
    expect(scopeAllows(ctx(["read"]), "admin")).toBe(false);
  });

  it("write scope implies read but NOT replay", () => {
    expect(scopeAllows(ctx(["write"]), "read")).toBe(true);
    expect(scopeAllows(ctx(["write"]), "write")).toBe(true);
    expect(scopeAllows(ctx(["write"]), "replay")).toBe(false);
    expect(scopeAllows(ctx(["write"]), "admin")).toBe(false);
  });

  it("replay scope implies read but NOT write", () => {
    expect(scopeAllows(ctx(["replay"]), "read")).toBe(true);
    expect(scopeAllows(ctx(["replay"]), "replay")).toBe(true);
    expect(scopeAllows(ctx(["replay"]), "write")).toBe(false);
    expect(scopeAllows(ctx(["replay"]), "admin")).toBe(false);
  });

  it("admin scope implies everything", () => {
    expect(scopeAllows(ctx(["admin"]), "read")).toBe(true);
    expect(scopeAllows(ctx(["admin"]), "write")).toBe(true);
    expect(scopeAllows(ctx(["admin"]), "replay")).toBe(true);
    expect(scopeAllows(ctx(["admin"]), "admin")).toBe(true);
  });

  it("multi-scope keys are union of implications", () => {
    const both = ctx(["write", "replay"]);
    expect(scopeAllows(both, "read")).toBe(true);
    expect(scopeAllows(both, "write")).toBe(true);
    expect(scopeAllows(both, "replay")).toBe(true);
    expect(scopeAllows(both, "admin")).toBe(false);
  });

  it("rejects an empty scope set", () => {
    expect(scopeAllows(ctx([]), "read")).toBe(false);
  });
});

describe("authenticateApiKey — workspace.status gate", () => {
  afterEach(() => queryMock.mockReset());

  it("authenticates a valid key for an active workspace", async () => {
    selectReturns(activeRow);
    expect(await authenticateApiKey("Bearer axl_live_token")).toEqual({
      workspace_id: "ws_1",
      scopes: ["admin"],
      key_id: "key_1",
    });
  });

  it("rejects a key whose workspace is suspended (no v1 write / billable replay)", async () => {
    selectReturns({ ...activeRow, workspace_status: "suspended" });
    expect(await authenticateApiKey("Bearer axl_live_token")).toBeNull();
  });

  it("rejects a key whose workspace is soft-deleted", async () => {
    selectReturns({ ...activeRow, workspace_status: "deleted" });
    expect(await authenticateApiKey("Bearer axl_live_token")).toBeNull();
  });

  it("rejects a revoked key even on an active workspace", async () => {
    selectReturns({ ...activeRow, revoked_at: "2026-06-01T00:00:00Z" });
    expect(await authenticateApiKey("Bearer axl_live_token")).toBeNull();
  });

  it("rejects when the JOIN returns no row (unknown / hard-deleted workspace)", async () => {
    selectReturns(null);
    expect(await authenticateApiKey("Bearer axl_live_token")).toBeNull();
  });

  it("rejects non-Bearer / non-axl tokens before touching the DB", async () => {
    selectReturns(activeRow);
    expect(await authenticateApiKey(null)).toBeNull();
    expect(await authenticateApiKey("Bearer sk_wrong_prefix")).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("authenticateApiKey — personal access tokens (axe_pat_)", () => {
  afterEach(() => queryMock.mockReset());

  const patRow = {
    id: "pat_1",
    workspace_id: "ws_pat",
    revoked_at: null,
    expires_at: null,
    workspace_status: "active",
    membership_role: "admin",
  };

  function patSelectReturns(row: Record<string, unknown> | null): void {
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT[\s\S]*personal_access_tokens/i.test(sql)) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 }; // last_used_at UPDATE
    });
  }

  it("authenticates a valid PAT and grants operational (not admin) scopes", async () => {
    patSelectReturns(patRow);
    expect(await authenticateApiKey("Bearer axe_pat_validtoken")).toEqual({
      workspace_id: "ws_pat",
      scopes: ["read", "write", "replay"],
      key_id: "pat_1",
    });
    expect(String(queryMock.mock.calls[0]?.[0])).toMatch(/JOIN workspace_members/i);
  });

  it("keeps a member PAT read-only", async () => {
    patSelectReturns({ ...patRow, membership_role: "member" });
    expect(await authenticateApiKey("Bearer axe_pat_member")).toEqual({
      workspace_id: "ws_pat",
      scopes: ["read"],
      key_id: "pat_1",
    });
  });

  it("rejects a revoked PAT", async () => {
    patSelectReturns({ ...patRow, revoked_at: "2026-06-01T00:00:00Z" });
    expect(await authenticateApiKey("Bearer axe_pat_revoked")).toBeNull();
  });

  it("rejects an expired PAT", async () => {
    patSelectReturns({ ...patRow, expires_at: "2000-01-01T00:00:00Z" });
    expect(await authenticateApiKey("Bearer axe_pat_expired")).toBeNull();
  });

  it("rejects a PAT for a suspended workspace", async () => {
    patSelectReturns({ ...patRow, workspace_status: "suspended" });
    expect(await authenticateApiKey("Bearer axe_pat_suspended")).toBeNull();
  });

  it("rejects an unknown PAT (no row)", async () => {
    patSelectReturns(null);
    expect(await authenticateApiKey("Bearer axe_pat_unknown")).toBeNull();
  });

  it("rejects a PAT when its membership join returns no row", async () => {
    patSelectReturns(null);
    expect(await authenticateApiKey("Bearer axe_pat_removed_member")).toBeNull();
    expect(String(queryMock.mock.calls[0]?.[0])).toMatch(/wm\.user_id = p\.user_id/i);
  });
});
