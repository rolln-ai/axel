import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processErasureRequest: vi.fn(),
}));

vi.mock("../lib/admin-auth", () => ({
  requireSuperAdmin: vi.fn(async () => ({ user: { id: "usr_admin" } })),
}));

vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "usr_owner" },
    activeWorkspace: {
      workspace_id: "ws_test",
      workspace_status: "active",
      role: "owner",
    },
  })),
}));

vi.mock("../lib/deployment-capabilities", () => ({
  deploymentCapabilities: vi.fn(() => ({ indexedSubjectErasure: true })),
}));

vi.mock("../lib/erasure-lifecycle", () => ({
  processErasureRequest: mocks.processErasureRequest,
}));

import { runWorkspaceErasureAction } from "../lib/erasure-actions";

function erasureForm(): FormData {
  const form = new FormData();
  form.append("kind", "email");
  form.append("value", "person@example.test");
  return form;
}

describe("erasure action error privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not reflect thrown storage or database details", async () => {
    const marker = "postgresql://user:marker-secret@private-db.internal/erasure";
    mocks.processErasureRequest.mockRejectedValueOnce(
      new Error(`DELETE FROM marker_schema failed: ${marker}`),
    );

    const result = await runWorkspaceErasureAction({}, erasureForm());

    expect(result).toEqual({
      error: "The erasure request failed. Review the operator logs and try again.",
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("marker_schema");
  });

  it("does not return lifecycle errors, store names, or request ids", async () => {
    const marker = "marker-secret provider response";
    mocks.processErasureRequest.mockResolvedValueOnce({
      requestId: "ers_marker_private_id",
      state: "failed",
      matchedEventCount: 2,
      coverage: "unknown",
      executed: true,
      storeResults: [{ store: "private_marker_schema", status: "failed", count: 0 }],
      deletionManifestHash: null,
      error: marker,
    });

    const result = await runWorkspaceErasureAction({}, erasureForm());
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      error: "The erasure request did not complete. Review the erasure audit record.",
    });
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("ers_marker_private_id");
    expect(serialized).not.toContain("private_marker_schema");
  });

  it("does not return deployment variable names or request ids in dry-run notices", async () => {
    mocks.processErasureRequest.mockResolvedValueOnce({
      requestId: "ers_marker_private_id",
      state: "found",
      matchedEventCount: 3,
      coverage: "unknown",
      executed: false,
      storeResults: [],
      deletionManifestHash: null,
    });

    const result = await runWorkspaceErasureAction({}, erasureForm());
    const serialized = JSON.stringify(result);

    expect(result.notice).toContain("erasure dry-run mode");
    expect(serialized).not.toContain("ERASURE_EXECUTE_ENABLED");
    expect(serialized).not.toContain("ers_marker_private_id");
  });
});
