import { describe, expect, it, vi } from "vitest";
import { writeAudit } from "../lib/audit";

/**
 * writeAudit is the single canonical audit_log INSERT — every dashboard
 * audit row goes through it. Lock down the column list, the param order,
 * and the metadata/default conventions so a drive-by edit can't silently
 * change the shape for all ~75 call sites at once.
 */

function capturingClient() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  };
}

describe("writeAudit", () => {
  it("writes the canonical 6-column row with JSON-encoded metadata", async () => {
    const client = capturingClient();
    await writeAudit(client, {
      workspaceId: "ws_1",
      actorUserId: "usr_1",
      action: "source.created",
      targetType: "source",
      targetId: "src_1",
      metadata: { via: "test", count: 2 },
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.sql).toMatch(
      /INSERT INTO audit_log \(workspace_id, actor_user_id, action, target_type, target_id, metadata\)/,
    );
    expect(client.calls[0]!.params).toEqual([
      "ws_1",
      "usr_1",
      "source.created",
      "source",
      "src_1",
      JSON.stringify({ via: "test", count: 2 }),
    ]);
  });

  it("stores an empty object when metadata is omitted", async () => {
    const client = capturingClient();
    await writeAudit(client, {
      workspaceId: "ws_1",
      actorUserId: "usr_1",
      action: "workspace.created",
      targetType: "workspace",
      targetId: "ws_1",
    });
    expect(client.calls[0]!.params[5]).toBe("{}");
  });

  it("encodes an explicit empty metadata object as '{}' (not NULL)", async () => {
    const client = capturingClient();
    await writeAudit(client, {
      workspaceId: "ws_1",
      actorUserId: "usr_1",
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: "key_1",
      metadata: {},
    });
    expect(client.calls[0]!.params[5]).toBe("{}");
  });

  it("accepts null workspace (platform events) and null actor (API keys)", async () => {
    const client = capturingClient();
    await writeAudit(client, {
      workspaceId: null,
      actorUserId: "usr_1",
      action: "user.password_reset",
      targetType: "user",
      targetId: "usr_1",
    });
    await writeAudit(client, {
      workspaceId: "ws_1",
      actorUserId: null,
      action: "api.source.created",
      targetType: "source",
      targetId: "src_1",
      metadata: { api_key_id: "key_1" },
    });
    expect(client.calls[0]!.params[0]).toBeNull();
    expect(client.calls[1]!.params[1]).toBeNull();
  });

  it("does not swallow query failures (caller keeps its failure semantics)", async () => {
    const client = {
      query: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    await expect(
      writeAudit(client, {
        workspaceId: "ws_1",
        actorUserId: "usr_1",
        action: "x",
        targetType: "y",
        targetId: "z",
      }),
    ).rejects.toThrow("db down");
  });
});
