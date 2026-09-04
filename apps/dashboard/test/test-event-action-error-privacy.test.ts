import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  clickhouseQuery: vi.fn(),
  dbQuery: vi.fn(),
  listSourceEvents: vi.fn(),
  resolveIngestBaseUrl: vi.fn(),
  usageEnabled: vi.fn(() => true),
}));

vi.mock("@axel/shared", () => ({
  resolveIngestBaseUrl: mocks.resolveIngestBaseUrl,
}));

vi.mock("../lib/db", () => ({
  db: () => ({ query: mocks.dbQuery }),
}));

vi.mock("../lib/clickhouse", () => ({
  clickhouse: () => ({ query: mocks.clickhouseQuery }),
}));

vi.mock("../lib/usage", () => ({
  listSourceEvents: mocks.listSourceEvents,
  usageEnabled: mocks.usageEnabled,
}));

vi.mock("../lib/with-mutation", () => ({
  withWorkspaceMutation: async (
    _options: unknown,
    fn: (context: unknown) => Promise<unknown>,
  ) => fn({
    workspaceId: "ws_test",
    actorUserId: "usr_test",
    audit: mocks.audit,
    tags: vi.fn(),
  }),
}));

import {
  getRecentIngestEvents,
  getTestEventOutcome,
  sendTestEvent,
} from "../lib/test-event-actions";

const originalAdminToken = process.env.INGEST_ADMIN_TOKEN;

function sendForm(): FormData {
  const form = new FormData();
  form.set("source_id", "src_test");
  form.set("payload", JSON.stringify({ kind: "test" }));
  return form;
}

describe("test-event action error privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INGEST_ADMIN_TOKEN = "admin_test_fixture";
    mocks.resolveIngestBaseUrl.mockReturnValue("https://ingest.example.test");
    mocks.dbQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.usageEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    if (originalAdminToken === undefined) delete process.env.INGEST_ADMIN_TOKEN;
    else process.env.INGEST_ADMIN_TOKEN = originalAdminToken;
    vi.unstubAllGlobals();
  });

  it("does not reflect ingest configuration exceptions", async () => {
    const marker = "https://marker-secret@private-ingest.internal/admin";
    mocks.resolveIngestBaseUrl.mockImplementationOnce(() => {
      throw new Error(marker);
    });

    const result = await sendTestEvent({}, sendForm());

    expect(result).toEqual({ error: "Test-event service is not configured." });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("private-ingest.internal");
  });

  it("does not name the missing admin-token variable", async () => {
    delete process.env.INGEST_ADMIN_TOKEN;

    const result = await sendTestEvent({}, sendForm());

    expect(result).toEqual({ error: "Test-event service is not configured." });
    expect(JSON.stringify(result)).not.toContain("INGEST_ADMIN_TOKEN");
  });

  it("does not reflect analytics query exceptions", async () => {
    const marker = "SELECT response_json FROM marker_schema.marker_table";
    mocks.clickhouseQuery.mockRejectedValueOnce(new Error(marker));

    const result = await getTestEventOutcome("evt_test");

    expect(result).toEqual({ error: "Test-event results are temporarily unavailable." });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("does not return stored connector error text", async () => {
    const marker = "receiver echoed marker-secret webhook payload";
    mocks.clickhouseQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            route_id: "rt_test",
            destination_id: "dst_test",
            status: "dead",
            latency_ms: 12,
            response_json: JSON.stringify({ http_status: 500, error: marker }),
          },
        ],
      });

    const result = await getTestEventOutcome("evt_test");

    expect(result).toMatchObject({
      outcome: {
        delivery_attempts: [{ http_status: 500, error: "Delivery failed." }],
      },
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("marker-secret");
  });

  it("does not reflect recent-event query exceptions", async () => {
    const marker = "clickhouse://marker-user:marker-secret@private-host/schema";
    mocks.listSourceEvents.mockRejectedValueOnce(new Error(marker));

    const result = await getRecentIngestEvents("src_test");

    expect(result).toEqual({ error: "Recent ingest activity is temporarily unavailable." });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
