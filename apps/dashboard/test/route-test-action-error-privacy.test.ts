import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clickhouseQuery: vi.fn(),
  dbQuery: vi.fn(),
  fetchPayload: vi.fn(),
  parseTransform: vi.fn(() => ({ kind: "passthrough" })),
  runTransform: vi.fn((payload: unknown) => payload),
}));

vi.mock("@axel/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@axel/shared")>();
  return {
    ...actual,
    parseTransform: mocks.parseTransform,
    runTransform: mocks.runTransform,
  };
});

vi.mock("../lib/db", () => ({
  db: () => ({ query: mocks.dbQuery }),
}));

vi.mock("../lib/clickhouse", () => ({
  clickhouse: () => ({ query: mocks.clickhouseQuery }),
}));

vi.mock("../lib/sample-payload", () => ({
  fetchPayloadForR2Key: mocks.fetchPayload,
}));

vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "usr_test" },
    activeWorkspace: {
      workspace_id: "ws_test",
      workspace_status: "active",
      role: "owner",
    },
  })),
}));

vi.mock("../lib/auth-guards", () => ({
  requireActiveWorkspace: vi.fn(() => null),
}));

vi.mock("../lib/usage", () => ({
  usageEnabled: vi.fn(() => true),
}));

import { RouteEngineError } from "@axel/shared";
import { testRouteAgainstRecentEvents } from "../lib/route-test-actions";

describe("route test action error privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbQuery.mockResolvedValue({
      rows: [
        {
          filter_expression: null,
          transform_script: JSON.stringify({ kind: "passthrough" }),
          pipeline_graph: null,
        },
      ],
      rowCount: 1,
    });
    mocks.fetchPayload.mockResolvedValue({ kind: "safe_fixture" });
    mocks.parseTransform.mockReturnValue({ kind: "passthrough" });
    mocks.runTransform.mockImplementation((payload: unknown) => payload);
  });

  it("does not reflect analytics query exceptions", async () => {
    const marker = "clickhouse://marker:secret@private-host/marker_schema";
    mocks.clickhouseQuery.mockRejectedValueOnce(new Error(marker));

    const result = await testRouteAgainstRecentEvents("rt_test", "src_test");

    expect(result).toEqual({ error: "Recent event data is temporarily unavailable." });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("private-host");
  });

  it("preserves a route-engine reason without returning its raw detail", async () => {
    const marker = "payload.customer_secret=marker-secret";
    mocks.clickhouseQuery.mockResolvedValueOnce({
      rows: [
        {
          event_id: "evt_test",
          received_at: "2026-08-27 12:00:00.000",
          r2_key: "events/test",
          content_type: "application/json",
        },
      ],
    });
    mocks.runTransform.mockImplementationOnce(() => {
      throw new RouteEngineError("transform_unsafe_path", marker);
    });

    const result = await testRouteAgainstRecentEvents("rt_test", "src_test");

    expect(result).toMatchObject({
      results: [
        {
          error: {
            reason: "transform_unsafe_path",
            message: "Route evaluation failed. Check the route configuration.",
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("marker-secret");
  });
});
