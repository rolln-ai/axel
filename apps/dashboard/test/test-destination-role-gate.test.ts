import { describe, expect, it, vi } from "vitest";

// Role gate on the connectivity probes (audit finding
// ux-destinations::test-destination-missing-role-gate): the dialogs that
// render them are owner/admin-only, but server actions are directly
// POST-able, so the probes themselves must enforce requireWritableRole —
// otherwise a member could make the server open outbound connections to
// hosts they supply.

const sessionState = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "member",
}));

vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "u1" },
    activeWorkspace: { workspace_id: "ws1", role: sessionState.role, workspace_status: "active" },
  })),
}));

import { preflightPipelineDestination, testDestination } from "../lib/test-destination";

function webhookForm(): FormData {
  const fd = new FormData();
  fd.set("type", "webhook");
  fd.set("name", "probe target");
  fd.set("url", "https://example.com/hook");
  return fd;
}

describe("testDestination role gate", () => {
  it("rejects members before running any probe", async () => {
    sessionState.role = "member";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await testDestination(webhookForm());
      expect(result.ok).toBe(false);
      expect(result.severity).toBe("fail");
      expect(result.message).toMatch(/only owners and admins/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets owners past the gate (fails later on validation, not role)", async () => {
    sessionState.role = "owner";
    const result = await testDestination(new FormData());
    expect(result.message).toMatch(/pick a destination type/i);
    expect(result.message).not.toMatch(/owners and admins/i);
  });
});

describe("preflightPipelineDestination role gate", () => {
  it("rejects members with a blocking 'fail' severity", async () => {
    sessionState.role = "member";
    const fd = new FormData();
    fd.set("destination_mode", "new");
    fd.set("new_destination_type", "webhook");
    const result = await preflightPipelineDestination(fd);
    expect(result.ok).toBe(false);
    expect(result.severity).toBe("fail");
    expect(result.message).toMatch(/only owners and admins/i);
  });

  it("lets admins past the gate", async () => {
    sessionState.role = "admin";
    const fd = new FormData();
    fd.set("destination_mode", "skip");
    fd.set("action_intent", "skip");
    const result = await preflightPipelineDestination(fd);
    expect(result.ok).toBe(true);
    expect(result.severity).toBe("pass");
  });
});
