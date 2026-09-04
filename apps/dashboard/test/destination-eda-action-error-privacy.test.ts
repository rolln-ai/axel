import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSeries: vi.fn(),
}));

vi.mock("../lib/clickhouse", () => ({
  hasClickhouseUrl: vi.fn(() => true),
}));

vi.mock("../lib/destination-metrics", () => ({
  getDestinationEdaSeries: mocks.getSeries,
}));

vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => ({
    activeWorkspace: {
      workspace_id: "ws_test",
      workspace_timezone: "America/Denver",
    },
  })),
}));

import { fetchDestinationEdaAction } from "../lib/destination-eda-actions";

describe("destination EDA action error privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not reflect analytics query exceptions", async () => {
    const marker = "clickhouse://marker:marker-secret@private-host/marker_schema";
    mocks.getSeries.mockRejectedValueOnce(new Error(`SELECT failed: ${marker}`));

    const result = await fetchDestinationEdaAction("dst_test", "hour", 24);

    expect(result).toEqual({
      ok: false,
      message: "Destination analytics are temporarily unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("marker-secret");
    expect(JSON.stringify(result)).not.toContain("private-host");
  });
});
