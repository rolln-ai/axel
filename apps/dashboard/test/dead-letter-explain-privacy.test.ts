import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fetchPayload: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: () => ({ query: mocks.query }),
}));
vi.mock("../lib/sample-payload", () => ({
  fetchPayloadForR2Key: mocks.fetchPayload,
}));
vi.mock("../lib/session", () => ({
  requireSession: async () => ({ activeWorkspace: { workspace_id: "ws_1" } }),
}));
vi.mock("../lib/app-url", () => ({
  appBaseUrl: () => "https://app.example.test",
}));

import { explainDeadLetter } from "../lib/dead-letter-explain";

const JWT = [
  "eyJhbGci",
  "OiJIUzI1",
  "NiJ9.",
  "eyJzdWIi",
  "OiJjdXN0",
  "b21lci0x",
  "In0.",
  "c2lnbmF0",
  "dXJlLXZh",
  "bHVl",
].join("");
const OPAQUE = ["Ab9_cdEf", "GhijKLMN", "opQRstUV", "wxYZ0123", "456789ab"].join("");

describe("dead-letter OpenRouter privacy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OPENROUTER_API_KEY = ["openrouter", "test", "key"].join("-");
    mocks.fetchPayload.mockResolvedValue({
      type: "invoice.paid",
      status: "complete",
      amount: 1299,
      customer_id: "cus_private_123",
      street_address: "123 Private Street",
      note_short: "tiny-private-value",
      description: "Ordinary customer prose must stay local",
      password: "hunter2",
      headers: {
        Authorization: "Bearer short-auth-value",
        Cookie: "session=short-cookie",
      },
      callback: `https://${"user"}:${"pass"}@example.test/hook?token=query-secret`,
      note: `${JWT} ${OPAQUE}`,
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (/FROM dead_letters/.test(sql)) {
        return {
          rows: [
            {
              id: "1",
              workspace_id: "ws_1",
              event_id: "evt_1",
              source_id: "src_1",
              route_id: "rt_1",
              destination_id: "dst_1",
              r2_key: "raw/ws_1/evt_1.json",
              reason: "destination_rejected",
              message:
                'column customer_id is missing; token="tiny-token"; Authorization: Basic dXNlcjpwYXNz',
              ai_summary: null,
              ai_suggested_action: null,
              ai_summarized_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM destinations/.test(sql)) {
        return {
          rows: [{ type: "webhook", name: "Private Partner Name" }],
          rowCount: 1,
        };
      }
      if (/FROM routes/.test(sql)) {
        return {
          rows: [
            {
              filter_expression: JSON.stringify({
                kind: "event_type_in",
                path: "type",
                values: ["private.event.type"],
              }),
              transform_script: JSON.stringify({
                kind: "collapse_arrays",
                fields: [
                  {
                    path: "tags",
                    format: "join",
                    separator: "PRIVATE_SEPARATOR_LITERAL",
                  },
                ],
              }),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
  });

  it("sends only structural webhook and allowlisted operational context", async () => {
    let requestBody: Record<string, unknown> | null = null;
    let requestRedirect: RequestRedirect | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestRedirect = init?.redirect;
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "The destination is missing customer_id.",
                    suggested_action: "Add the customer_id column.",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const form = new FormData();
    form.set("dead_letter_id", "1");
    const result = await explainDeadLetter({}, form);

    const body = requestBody as unknown as {
      provider?: { data_collection?: string };
      messages?: Array<{ role?: string; content?: string }>;
    };
    const prompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
    for (const secret of [
      "hunter2",
      "short-auth-value",
      "short-cookie",
      "user:pass",
      "query-secret",
      JWT,
      OPAQUE,
      "tiny-token",
      "dXNlcjpwYXNz",
      "invoice.paid",
      "complete",
      "1299",
      "cus_private_123",
      "123 Private Street",
      "tiny-private-value",
      "Ordinary customer prose must stay local",
      "Private Partner Name",
      "private.event.type",
      "PRIVATE_SEPARATOR_LITERAL",
      "column customer_id is missing",
    ]) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain("customer_id");
    expect(prompt).toContain('"amount":"[number]"');
    expect(prompt).toContain('"street_address":"[string]"');
    expect(prompt).toContain('"destination_type":"webhook"');
    expect(prompt).toContain('"values_withheld":true');
    expect(prompt).toContain('"kind":"collapse_arrays"');
    expect(prompt).toContain('"path":"tags"');
    expect(prompt).toContain('"separator_present":true');
    expect(body.provider).toEqual({ data_collection: "deny" });
    expect(requestRedirect).toBe("manual");
    expect(result.data?.summary).toContain("customer_id");
  });
});
