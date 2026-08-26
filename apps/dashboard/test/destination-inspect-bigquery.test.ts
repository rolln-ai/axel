import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mintToken: vi.fn(async () => "ya29.test"),
}));

vi.mock("../lib/db", () => ({
  db: () => ({ query: mocks.query }),
}));

vi.mock("../lib/credentials", () => ({
  credentialAad: () => Buffer.from("aad"),
  decryptCredentialBlob: () => JSON.stringify({ service_account_json: "{}" }),
}));

vi.mock("../lib/bigquery-auth", () => ({
  BIGQUERY_API_ROOT: "https://bigquery.googleapis.com/bigquery/v2",
  BIGQUERY_SCOPE: "https://www.googleapis.com/auth/bigquery",
  parseServiceAccountJson: () => ({}),
  mintGoogleAccessToken: mocks.mintToken,
}));

import {
  inspectBigQueryDestination,
  listBigQueryTables,
  listBigQueryDatasets,
  listBigQueryTablesForDataset,
  listBigQueryDatasetsForCredentials,
} from "../lib/destination-inspect";

const destinationRow = {
  id: "dst_bq",
  workspace_id: "ws_1",
  name: "warehouse",
  type: "bigquery",
  config: { project_id: "my-proj", dataset: "marketing" },
  status: "active",
  credentials_ref: "cred_1",
  ciphertext: Buffer.from("ciphertext"),
  nonce: Buffer.from("nonce"),
  auth_tag: Buffer.from("tag"),
  encryption_version: 2,
};

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("BigQuery destination inspection across datasets", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [destinationRow] });
    mocks.mintToken.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists qualified tables from every accessible dataset", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (/\/projects\/my-proj\/datasets\?/.test(url)) {
        return response(200, {
          datasets: [
            { datasetReference: { datasetId: "marketing" } },
            { datasetReference: { datasetId: "analytics" } },
          ],
        });
      }
      if (url.includes("/datasets/marketing/tables?")) {
        return response(200, {
          tables: [{ tableReference: { tableId: "events" } }],
        });
      }
      if (url.includes("/datasets/analytics/tables?")) {
        return response(200, {
          tables: [
            { tableReference: { tableId: "events" } },
            { tableReference: { tableId: "invoices" } },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listBigQueryTables("dst_bq", "ws_1");

    expect(result.tables).toEqual([
      { schema: "analytics", name: "events" },
      { schema: "analytics", name: "invoices" },
      { schema: "marketing", name: "events" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("queries the dataset selected by the data viewer instead of the default", async () => {
    let queryBody: { query?: string } | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      queryBody = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      return response(200, {
        jobComplete: true,
        schema: { fields: [{ name: "id", type: "STRING" }] },
        rows: [{ f: [{ v: "inv_1" }] }],
        totalRows: "1",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectBigQueryDestination("dst_bq", "ws_1", {
      dataset: "analytics",
      table: "invoices",
    });

    expect(queryBody?.query).toBe(
      "SELECT * FROM `my-proj.analytics.invoices` LIMIT 100",
    );
    expect(result.rows).toEqual([{ id: "inv_1" }]);
  });
});

describe("BigQuery guided dataset+table picker listings", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [destinationRow] });
    mocks.mintToken.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists datasets (sorted) for a saved destination", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (/\/projects\/my-proj\/datasets\?/.test(url)) {
        return response(200, {
          datasets: [
            { datasetReference: { datasetId: "marketing" } },
            { datasetReference: { datasetId: "analytics" } },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await listBigQueryDatasets("dst_bq", "ws_1")).toEqual(["analytics", "marketing"]);
  });

  it("lists tables in a chosen dataset (sorted)", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/datasets/analytics/tables?")) {
        return response(200, {
          tables: [
            { tableReference: { tableId: "invoices" } },
            { tableReference: { tableId: "events" } },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await listBigQueryTablesForDataset("dst_bq", "ws_1", "analytics")).toEqual([
      "events",
      "invoices",
    ]);
  });

  it("lists datasets from just-entered credentials without touching the DB", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (/\/projects\/my-proj\/datasets\?/.test(url)) {
        return response(200, { datasets: [{ datasetReference: { datasetId: "warehouse" } }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await listBigQueryDatasetsForCredentials("my-proj", "{}")).toEqual(["warehouse"]);
    // The credentials path lists directly — no saved destination is loaded.
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
