import type http from "node:http";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { authenticateCliRequest, cliRoleAllowsWrite } from "../src/cli-api.js";

function request(token = "axe_pat_valid"): http.IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as http.IncomingMessage;
}

function poolReturning(row: Record<string, unknown> | null): { pool: pg.Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string) => {
    if (/SELECT[\s\S]*personal_access_tokens/i.test(sql)) {
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as pg.Pool, query };
}

const activeMember = {
  pat_id: "pat_1",
  pat_name: "laptop",
  pat_created_at: "2026-08-01T00:00:00Z",
  pat_expires_at: null,
  pat_revoked_at: null,
  user_id: "usr_1",
  user_email: "member@example.com",
  workspace_id: "ws_1",
  workspace_name: "Acme",
  workspace_status: "active",
  membership_role: "member",
};

describe("CLI PAT authorization", () => {
  it("requires the token owner to remain a workspace member", async () => {
    const { pool, query } = poolReturning(activeMember);
    const result = await authenticateCliRequest(request(), pool);

    expect(result).toMatchObject({ workspace_id: "ws_1", membership_role: "member" });
    expect(String(query.mock.calls[0]?.[0])).toMatch(/JOIN workspace_members/i);
    expect(String(query.mock.calls[0]?.[0])).toMatch(/wm\.user_id = pat\.user_id/i);
  });

  it("rejects a removed member because the membership join returns no row", async () => {
    const { pool } = poolReturning(null);
    await expect(authenticateCliRequest(request(), pool)).resolves.toMatchObject({
      error: { status: 401, code: "invalid_token" },
    });
  });

  it("rejects tokens for inactive workspaces", async () => {
    const { pool } = poolReturning({ ...activeMember, workspace_status: "suspended" });
    await expect(authenticateCliRequest(request(), pool)).resolves.toMatchObject({
      error: { status: 401, code: "inactive_workspace" },
    });
  });

  it("allows only owners and admins to trigger writes", () => {
    expect(cliRoleAllowsWrite("owner")).toBe(true);
    expect(cliRoleAllowsWrite("admin")).toBe(true);
    expect(cliRoleAllowsWrite("member")).toBe(false);
  });
});
