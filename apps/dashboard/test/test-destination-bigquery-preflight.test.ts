import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mintToken: vi.fn(async () => "ya29.test"),
  parseServiceAccount: vi.fn((raw: string) => JSON.parse(raw)),
}));

vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "u1" }, activeWorkspace: { workspace_id: "ws1", role: "owner", workspace_status: "active" } })),
}));

vi.mock("../lib/bigquery-auth", () => ({
  BIGQUERY_API_ROOT: "https://bigquery.googleapis.com/bigquery/v2",
  BIGQUERY_SCOPE: "https://www.googleapis.com/auth/bigquery",
  parseServiceAccountJson: mocks.parseServiceAccount,
  mintGoogleAccessToken: mocks.mintToken,
}));

import { preflightPipelineDestination } from "../lib/test-destination";

/** Mirror of the create-time gate: block only on a provable "fail". */
const blocksActivation = (r: { severity?: string }) => r.severity === "fail";

const SA_JSON = JSON.stringify({ type: "service_account", client_email: "svc@p.iam.gserviceaccount.com", private_key: "k" });

function bqForm(target: string) {
  const fd = new FormData();
  fd.set("destination_mode", "new");
  fd.set("new_destination_type", "bigquery");
  fd.set("new_destination_name", "warehouse");
  fd.set("dest_field_project_id", "my-proj");
  fd.set("dest_field_service_account_json", SA_JSON);
  fd.set("new_destination_target", target);
  return fd;
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const DATASET_GET = /\/datasets\/warehouse$/;
const TEST_PERMS = /\/tables\/events:testIamPermissions$/;
const TABLE_GET = /\/tables\/events$/;

describe("BigQuery write pre-flight (preflightPipelineDestination)", () => {
  beforeEach(() => {
    mocks.mintToken.mockReset();
    mocks.mintToken.mockResolvedValue("ya29.test");
    mocks.parseServiceAccount.mockReset();
    mocks.parseServiceAccount.mockImplementation((raw: string) => JSON.parse(raw));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("passes when the service account can write to an existing table", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (DATASET_GET.test(url)) return json(200, { id: "warehouse" });
      if (TEST_PERMS.test(url)) return json(200, { permissions: ["bigquery.tables.updateData"] });
      throw new Error(`unexpected ${url}`);
    }));
    const result = await preflightPipelineDestination(bqForm("warehouse.events"));
    expect(result.severity).toBe("pass");
    expect(blocksActivation(result)).toBe(false);
  });

  it("BLOCKS when the table exists but the SA can't write (Data Viewer only) — the incident", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (DATASET_GET.test(url)) return json(200, { id: "warehouse" });
      if (TEST_PERMS.test(url)) return json(200, { permissions: [] }); // no updateData
      if (TABLE_GET.test(url) && init?.method !== "POST") return json(200, { id: "events" }); // table exists
      throw new Error(`unexpected ${url}`);
    }));
    const result = await preflightPipelineDestination(bqForm("warehouse.events"));
    expect(result.severity).toBe("fail");
    expect(blocksActivation(result)).toBe(true);
    expect(result.message).toMatch(/can read but not write|Data Editor/i);
  });

  it("WARNS (allows) for a brand-new table that doesn't exist yet — can't verify in advance", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (DATASET_GET.test(url)) return json(200, { id: "warehouse" });
      if (TEST_PERMS.test(url)) return json(200, { permissions: [] });
      if (TABLE_GET.test(url)) return json(404, { error: "notFound" });
      throw new Error(`unexpected ${url}`);
    }));
    const result = await preflightPipelineDestination(bqForm("warehouse.events"));
    expect(result.severity).toBe("warn");
    expect(blocksActivation(result)).toBe(false);
  });

  it("BLOCKS when the dataset itself is access-denied", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (DATASET_GET.test(url)) return json(403, { error: "accessDenied" });
      throw new Error(`unexpected ${url}`);
    }));
    const result = await preflightPipelineDestination(bqForm("warehouse.events"));
    expect(result.severity).toBe("fail");
    expect(blocksActivation(result)).toBe(true);
    expect(result.message).toMatch(/Data Editor/i);
  });

  it("omits provider response bodies from pre-flight errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (DATASET_GET.test(url)) {
        return json(500, { error: "provider-private-response" });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const result = await preflightPipelineDestination(bqForm("warehouse.events"));
    expect(result).toMatchObject({
      ok: false,
      severity: "fail",
      message: "BigQuery returned HTTP 500.",
    });
    expect(result.message).not.toContain("provider-private-response");
  });

  it("does not reflect service-account parser details", async () => {
    const marker = "marker-private-key-parser-content";
    mocks.parseServiceAccount.mockImplementationOnce(() => {
      throw new Error(`invalid key near ${marker}`);
    });

    const result = await preflightPipelineDestination(bqForm("warehouse.events"));

    expect(result).toEqual({
      ok: false,
      severity: "fail",
      message: "Service account key JSON is invalid.",
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("does not reflect authentication exceptions", async () => {
    const marker = "postgresql://user:marker-secret@private-db.internal/schema";
    mocks.mintToken.mockRejectedValueOnce(new Error(marker));

    const result = await preflightPipelineDestination(bqForm("warehouse.events"));

    expect(result).toEqual({
      ok: false,
      severity: "fail",
      message: "Could not authenticate with BigQuery. Check the service account key.",
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("private-db.internal");
  });

  it("does not reflect project, dataset, or table identifiers in provider failures", async () => {
    const form = bqForm("marker_dataset.marker_table");
    form.set("dest_field_project_id", "marker-project");
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { error: "accessDenied" })));

    const result = await preflightPipelineDestination(form);
    const serialized = JSON.stringify(result);

    expect(result.severity).toBe("fail");
    expect(serialized).not.toContain("marker-project");
    expect(serialized).not.toContain("marker_dataset");
    expect(serialized).not.toContain("marker_table");
  });
});
