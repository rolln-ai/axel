import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "@axel/shared";
import { createBigQueryConnector, clearBigQueryTokenCache } from "../src/connectors/bigquery.ts";

// A real RSA key so the connector's RS256 JWT signing actually runs.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const serviceAccountJson = JSON.stringify({
  type: "service_account",
  client_email: "axel@my-proj.iam.gserviceaccount.com",
  private_key: privateKey,
  token_uri: "https://oauth2.googleapis.com/token",
  project_id: "my-proj",
});

const destination = (over: Partial<Record<string, unknown>> = {}): Destination => ({
  destination_id: "dest_bq_1",
  workspace_id: "ws_1",
  type: "bigquery",
  config: {
    project_id: "my-proj",
    dataset: "webhooks",
    service_account_json: serviceAccountJson,
    ...over,
  } as unknown as Destination["config"],
  credentials_ref: "cred_1",
});

const encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer;

interface FakeRes {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}
const makeRes = (status: number, body: unknown): FakeRes => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

// Per-test response knobs.
let tokenRes: FakeRes;
let insertSeq: FakeRes[]; // consumed in order; last entry repeats
let createTableRes: FakeRes;
let getTableSeq: FakeRes[];
let patchSeq: FakeRes[];
let lastInsertBody: unknown;
const calls: Array<{
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}> = [];

const fetchMock = vi.fn(async (
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> },
) => {
  const method = init.method ?? "GET";
  calls.push({
    url,
    method,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(init.headers !== undefined ? { headers: init.headers } : {}),
  });
  if (url.endsWith("/token")) return tokenRes;
  if (url.endsWith("/insertAll")) {
    lastInsertBody = init.body ? JSON.parse(init.body) : undefined;
    return insertSeq.length > 1 ? insertSeq.shift()! : insertSeq[0];
  }
  if (url.endsWith("/tables") && method === "POST") return createTableRes;
  if (/\/tables\/[^/]+$/.test(url) && method === "GET") {
    return getTableSeq.length > 1 ? getTableSeq.shift()! : getTableSeq[0];
  }
  if (/\/tables\/[^/]+$/.test(url) && method === "PATCH") {
    return patchSeq.length > 1 ? patchSeq.shift()! : patchSeq[0];
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
});

const deliver = (event: ArrayBuffer, dest: Destination, ctx: Parameters<ReturnType<typeof createBigQueryConnector>["deliver"]>[2]) =>
  createBigQueryConnector().deliver(event, dest, ctx);

describe("bigquery connector", () => {
  beforeEach(() => {
    clearBigQueryTokenCache();
    fetchMock.mockClear();
    calls.length = 0;
    lastInsertBody = undefined;
    tokenRes = makeRes(200, { access_token: "ya29.fake", expires_in: 3600 });
    insertSeq = [makeRes(200, {})];
    createTableRes = makeRes(200, {});
    getTableSeq = [makeRes(200, { etag: "etag-default", schema: { fields: [] } })];
    patchSeq = [makeRes(200, {})];
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("streams a json_column row with insertId=event_id and payload string", async () => {
    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-42",
      binding: { table: "events", mode: "json_column", payload_column: "body" },
    });
    expect(out.status).toBe("success");
    const row = (lastInsertBody as { rows: Array<{ insertId: string; json: Record<string, unknown> }> }).rows[0];
    expect(row.insertId).toBe("evt-42");
    expect(row.json).toEqual({ body: JSON.stringify({ a: 1 }) });
    expect((lastInsertBody as { ignoreUnknownValues: boolean }).ignoreUnknownValues).toBe(false);
  });

  it("typed_records keeps native scalar types in the row and creates typed columns", async () => {
    // First insert 404s (table missing) → connector creates it, then re-inserts.
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } }), makeRes(200, {})];
    const out = await deliver(
      encode({ id: 42, active: true, ratio: 0.5, data: { lead_score: 9 } }),
      destination(),
      { eventId: "evt-typed", binding: { table: "subs", dataset: "webhooks", mode: "typed_records" } },
    );
    expect(out.status).toBe("success");

    // Native types preserved in the streamed row — not stringified.
    const row = (lastInsertBody as { rows: Array<{ json: Record<string, unknown> }> }).rows[0];
    expect(row.json).toEqual({ id: 42, active: true, ratio: 0.5, data: { lead_score: 9 } });

    // Boolean/string types stay native. Integer-looking JSON numbers are
    // created as FLOAT64 because one event cannot prove they remain integral.
    const createCall = calls.find((c) => c.url.endsWith("/tables") && c.method === "POST");
    const created = JSON.parse(createCall!.body!) as {
      schema: { fields: Array<{ name: string; type: string; fields?: Array<{ name: string; type: string }> }> };
    };
    const byName = Object.fromEntries(created.schema.fields.map((f) => [f.name, f.type]));
    expect(byName.id).toBe("FLOAT64");
    expect(byName.active).toBe("BOOL");
    expect(byName.ratio).toBe("FLOAT64");
    expect(created.schema.fields.find((field) => field.name === "data")?.fields).toEqual([
      { name: "lead_score", type: "FLOAT64", mode: "NULLABLE" },
    ]);
  });

  it("adds integer-looking typed fields as FLOAT64 to prevent later numeric drift", async () => {
    insertSeq = [
      makeRes(200, {
        insertErrors: [{
          index: 0,
          errors: [{ reason: "invalid", message: "no such field: data.properties.total_taxes." }],
        }],
      }),
      makeRes(200, {}),
    ];
    getTableSeq = [makeRes(200, {
      etag: "etag-typed-v1",
      schema: {
        fields: [{
          name: "data",
          type: "RECORD",
          mode: "NULLABLE",
          fields: [{
            name: "properties",
            type: "RECORD",
            mode: "NULLABLE",
            fields: [],
          }],
        }],
      },
    })];

    const out = await deliver(
      encode({ data: { properties: { total_taxes: 1 } } }),
      destination(),
      { eventId: "evt-typed-add", binding: { table: "events", mode: "typed_records" } },
    );

    expect(out.status).toBe("success");
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(JSON.parse(patchCall!.body!)).toEqual({
      schema: {
        fields: [{
          name: "data",
          type: "RECORD",
          mode: "NULLABLE",
          fields: [{
            name: "properties",
            type: "RECORD",
            mode: "NULLABLE",
            fields: [{ name: "total_taxes", type: "FLOAT64", mode: "NULLABLE" }],
          }],
        }],
      },
    });
  });

  it("uses the route binding dataset instead of the destination default", async () => {
    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-cross-dataset",
      binding: {
        dataset: "analytics",
        table: "events",
        mode: "json_column",
      },
    });

    expect(out.status).toBe("success");
    expect(out.response).toMatchObject({ table: "my-proj.analytics.events" });
    const insertCall = calls.find((call) => call.url.endsWith("/insertAll"));
    expect(insertCall?.url).toContain("/datasets/analytics/tables/events/insertAll");
    expect(insertCall?.url).not.toContain("/datasets/webhooks/");
  });

  it("uses the binding dataset for table creation and its tableReference", async () => {
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } }), makeRes(200, {})];
    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-cross-dataset-create",
      binding: {
        dataset: "analytics",
        table: "fresh_events",
        mode: "nested_records",
      },
    });

    expect(out.status).toBe("success");
    const createCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/tables"));
    expect(createCall?.url).toContain("/datasets/analytics/tables");
    expect(JSON.parse(createCall!.body!) as { tableReference: unknown }).toMatchObject({
      tableReference: {
        projectId: "my-proj",
        datasetId: "analytics",
        tableId: "fresh_events",
      },
    });
  });

  it("uses the binding dataset for schema reads and patches", async () => {
    insertSeq = [
      makeRes(200, {
        insertErrors: [{
          index: 0,
          errors: [{ reason: "invalid", message: "no such field: b." }],
        }],
      }),
      makeRes(200, {}),
    ];
    getTableSeq = [makeRes(200, {
      etag: "etag-cross-dataset",
      schema: { fields: [{ name: "a", type: "STRING", mode: "NULLABLE" }] },
    })];
    patchSeq = [makeRes(200, {})];

    const out = await deliver(encode({ a: 1, b: 2 }), destination(), {
      eventId: "evt-cross-dataset-patch",
      binding: {
        dataset: "analytics",
        table: "events",
        mode: "columns",
      },
    });

    expect(out.status).toBe("success");
    const tableMetadataCalls = calls.filter((call) =>
      call.method === "GET" || call.method === "PATCH",
    );
    expect(tableMetadataCalls).toHaveLength(2);
    expect(tableMetadataCalls.every((call) =>
      call.url.includes("/datasets/analytics/tables/events"),
    )).toBe(true);
  });

  it("accepts a binding dataset without config.dataset and rejects an invalid resolved dataset", async () => {
    const accepted = await deliver(
      encode({ a: 1 }),
      destination({ dataset: undefined }),
      { eventId: "evt-binding-only-dataset", binding: { dataset: "analytics", table: "events" } },
    );
    expect(accepted.status).toBe("success");

    fetchMock.mockClear();
    calls.length = 0;
    const rejected = await deliver(
      encode({ a: 1 }),
      destination({ dataset: undefined }),
      { eventId: "evt-invalid-dataset", binding: { dataset: "bad.dataset", table: "events" } },
    );
    expect(rejected.status).toBe("dead");
    expect(rejected.response).toEqual({ error: "invalid dataset: bad.dataset" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dead-letters before auth when neither binding nor config provides a dataset", async () => {
    const out = await deliver(
      encode({ a: 1 }),
      destination({ dataset: undefined }),
      { eventId: "evt-missing-dataset", binding: { table: "events" } },
    );

    expect(out.status).toBe("dead");
    expect(out.response).toEqual({
      error: "no dataset binding or default configured for this route/destination",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("columns mode flattens leaves to strings without silently ignoring unknown columns", async () => {
    const out = await deliver(encode({ a: 1, b: "x" }), destination(), {
      eventId: "evt-1",
      binding: { table: "events", mode: "columns" },
    });
    expect(out.status).toBe("success");
    const body = lastInsertBody as { ignoreUnknownValues: boolean; rows: Array<{ json: unknown }> };
    expect(body.ignoreUnknownValues).toBe(false);
    expect(body.rows[0].json).toEqual({ a: "1", b: "x" });
  });

  it("ignores a hostile service-account token_uri for both JWT audience and token exchange", async () => {
    const hostileServiceAccount = JSON.stringify({
      type: "service_account",
      client_email: "hostile-uri@my-proj.iam.gserviceaccount.com",
      private_key: privateKey,
      token_uri: "https://attacker.example/token",
      project_id: "my-proj",
    });

    const out = await deliver(
      encode({ a: 1 }),
      destination({ service_account_json: hostileServiceAccount }),
      { eventId: "evt-fixed-token-uri", binding: { table: "events" } },
    );

    expect(out.status).toBe("success");
    const tokenCall = calls[0];
    expect(tokenCall.url).toBe("https://oauth2.googleapis.com/token");
    const assertion = new URLSearchParams(tokenCall.body).get("assertion");
    expect(assertion).toBeTruthy();
    const claims = JSON.parse(Buffer.from(assertion!.split(".")[1]!, "base64url").toString("utf8")) as {
      aud: string;
    };
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(calls.map((call) => new URL(call.url).hostname)).not.toContain("attacker.example");
  });

  it("columns mode flattens arbitrarily nested objects + stringifies arrays (never 'not a record')", async () => {
    const out = await deliver(
      encode({
        event: "subscriber.created",
        data: { subscriber: { email: "a@b.com", id: 7 }, properties: { url: "x" } },
        items: [1, 2],
        nothing: null,
      }),
      destination(),
      { eventId: "evt-nested", binding: { table: "data-temp", mode: "columns" } },
    );
    expect(out.status).toBe("success");
    const row = (lastInsertBody as { rows: Array<{ json: Record<string, unknown> }> }).rows[0];
    expect(row.json).toEqual({
      event: "subscriber.created",
      data_subscriber_email: "a@b.com",
      data_subscriber_id: "7",
      data_properties_url: "x",
      items: "[1,2]",
      // null leaves are skipped
    });
  });

  it("nested_records creates a nested newsletter schema and inserts the matching nested row", async () => {
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } }), makeRes(200, {})];
    const event = {
      event: "subscriber.updated",
      data: {
        account_id: "acct_1",
        properties: {
          source: "checkout",
          retry_count: 2,
          conversion_rate: 0.25,
          valid: true,
          ignored: null,
        },
        subscriber: {
          id: "sub_1",
          email: "member@example.com",
          custom_fields: { "LOYALTY-TIER": "VIP" },
          tags: ["newsletter", "vip"],
        },
      },
      occurred_at: "2030-01-15T12:00:00Z",
      null_only: null,
      empty_object: {},
      all_null_object: { value: null },
    };

    const out = await deliver(encode(event), destination(), {
      eventId: "evt-newsletter",
      binding: { table: "data_nested", mode: "nested_records" },
    });

    expect(out.status).toBe("success");
    const row = (lastInsertBody as { rows: Array<{ json: Record<string, unknown> }> }).rows[0];
    expect(row.json).toEqual({
      event: "subscriber.updated",
      data: {
        account_id: "acct_1",
        properties: {
          source: "checkout",
          retry_count: "2",
          conversion_rate: "0.25",
          valid: "true",
        },
        subscriber: {
          id: "sub_1",
          email: "member@example.com",
          custom_fields: { LOYALTY_TIER: "VIP" },
          tags: ["newsletter", "vip"],
        },
      },
      occurred_at: "2030-01-15T12:00:00Z",
    });

    const createCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/tables"));
    expect(createCall).toBeDefined();
    expect(JSON.parse(createCall!.body!)).toEqual({
      tableReference: { projectId: "my-proj", datasetId: "webhooks", tableId: "data_nested" },
      schema: {
        fields: [
          { name: "event", type: "STRING", mode: "NULLABLE" },
          {
            name: "data",
            type: "RECORD",
            mode: "NULLABLE",
            fields: [
              { name: "account_id", type: "STRING", mode: "NULLABLE" },
              {
                name: "properties",
                type: "RECORD",
                mode: "NULLABLE",
                fields: [
                  { name: "source", type: "STRING", mode: "NULLABLE" },
                  { name: "retry_count", type: "STRING", mode: "NULLABLE" },
                  { name: "conversion_rate", type: "STRING", mode: "NULLABLE" },
                  { name: "valid", type: "STRING", mode: "NULLABLE" },
                ],
              },
              {
                name: "subscriber",
                type: "RECORD",
                mode: "NULLABLE",
                fields: [
                  { name: "id", type: "STRING", mode: "NULLABLE" },
                  { name: "email", type: "STRING", mode: "NULLABLE" },
                  {
                    name: "custom_fields",
                    type: "RECORD",
                    mode: "NULLABLE",
                    fields: [{ name: "LOYALTY_TIER", type: "STRING", mode: "NULLABLE" }],
                  },
                  { name: "tags", type: "STRING", mode: "REPEATED" },
                ],
              },
            ],
          },
          { name: "occurred_at", type: "STRING", mode: "NULLABLE" },
        ],
      },
    });
  });

  it("nested_records string-normalizes REPEATED fields and uses JSON siblings for ambiguous arrays", async () => {
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } }), makeRes(200, {})];
    const event = {
      items: [
        { sku: "a", quantity: 1, detail: { fragile: true } },
        { sku: "b", price: 2.5, detail: { color: "amber" } },
      ],
      numeric_records: [{ value: 1 }, { value: 2.5 }],
      ids: [1, 2, 3],
      measurements: [1, 2.5],
      flags: [true, false],
      empty: [],
      all_null: [null, null],
      mixed_primitives: [1, "2", true],
      with_null: [1, null],
      matrix: [[1], [2]],
      drifting_records: [{ value: 1 }, { value: "one" }],
      object_scalar: [{ value: 1 }, "one"],
    };

    const out = await deliver(encode(event), destination(), {
      eventId: "evt-arrays",
      binding: { table: "array_events", mode: "nested_records" },
    });

    expect(out.status).toBe("success");
    const row = (lastInsertBody as { rows: Array<{ json: Record<string, unknown> }> }).rows[0];
    expect(row.json).toEqual({
      items: [
        { sku: "a", quantity: "1", detail: { fragile: "true" } },
        { sku: "b", price: "2.5", detail: { color: "amber" } },
      ],
      numeric_records: [{ value: "1" }, { value: "2.5" }],
      ids: ["1", "2", "3"],
      measurements: ["1", "2.5"],
      flags: ["true", "false"],
      mixed_primitives: ["1", "2", "true"],
      with_null__json: "[1,null]",
      matrix__json: "[[1],[2]]",
      drifting_records: [{ value: "1" }, { value: "one" }],
      object_scalar__json: '[{"value":1},"one"]',
    });

    const createCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/tables"));
    const createBody = JSON.parse(createCall!.body!) as { schema: { fields: Array<Record<string, unknown>> } };
    expect(createBody.schema.fields).toEqual([
      {
        name: "items",
        type: "RECORD",
        mode: "REPEATED",
        fields: [
          { name: "sku", type: "STRING", mode: "NULLABLE" },
          { name: "quantity", type: "STRING", mode: "NULLABLE" },
          {
            name: "detail",
            type: "RECORD",
            mode: "NULLABLE",
            fields: [
              { name: "fragile", type: "STRING", mode: "NULLABLE" },
              { name: "color", type: "STRING", mode: "NULLABLE" },
            ],
          },
          { name: "price", type: "STRING", mode: "NULLABLE" },
        ],
      },
      {
        name: "numeric_records",
        type: "RECORD",
        mode: "REPEATED",
        fields: [{ name: "value", type: "STRING", mode: "NULLABLE" }],
      },
      { name: "ids", type: "STRING", mode: "REPEATED" },
      { name: "measurements", type: "STRING", mode: "REPEATED" },
      { name: "flags", type: "STRING", mode: "REPEATED" },
      { name: "mixed_primitives", type: "STRING", mode: "REPEATED" },
      { name: "with_null__json", type: "STRING", mode: "NULLABLE" },
      { name: "matrix__json", type: "STRING", mode: "NULLABLE" },
      {
        name: "drifting_records",
        type: "RECORD",
        mode: "REPEATED",
        fields: [{ name: "value", type: "STRING", mode: "NULLABLE" }],
      },
      { name: "object_scalar__json", type: "STRING", mode: "NULLABLE" },
    ]);
  });

  it("nested_records rejects an explicit key that collides with a reserved JSON sibling", async () => {
    const out = await deliver(
      encode({ items: [1, null], items__json: "customer-owned" }),
      destination(),
      { eventId: "evt-json-sibling-collision", binding: { table: "events", mode: "nested_records" } },
    );

    expect(out.status).toBe("dead");
    expect(out.response).toEqual({
      error: expect.stringContaining("JSON sibling collision"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nested_records recursively evolves nullable and repeated RECORD fields without deleting schema", async () => {
    insertSeq = [
      makeRes(200, {
        insertErrors: [{
          index: 0,
          errors: [{ reason: "invalid", message: "no such field: data.subscriber.email." }],
        }],
      }),
      makeRes(200, {}),
    ];
    getTableSeq = [makeRes(200, {
      etag: "etag-nested-v1",
      schema: {
        fields: [
          { name: "event", type: "STRING", mode: "REQUIRED", description: "keep event metadata" },
          {
            name: "data",
            type: "RECORD",
            mode: "REQUIRED",
            description: "keep record metadata",
            fields: [
              {
                name: "subscriber",
                type: "RECORD",
                mode: "NULLABLE",
                fields: [
                  { name: "id", type: "STRING", mode: "NULLABLE", description: "stable id" },
                ],
              },
              {
                name: "properties",
                type: "RECORD",
                mode: "NULLABLE",
                fields: [{ name: "source", type: "STRING", mode: "NULLABLE" }],
              },
            ],
          },
          {
            name: "items",
            type: "RECORD",
            mode: "REPEATED",
            fields: [{ name: "sku", type: "STRING", mode: "NULLABLE" }],
          },
          { name: "legacy_only", type: "STRING", mode: "NULLABLE" },
        ],
      },
    })];
    patchSeq = [makeRes(200, {})];

    const out = await deliver(
      encode({
        event: "subscriber.updated",
        data: {
          subscriber: { id: "sub_1", email: "member@example.com", custom_fields: { loyalty_tier: 3 } },
          properties: { source: "checkout", campaign: "summer" },
        },
        items: [{ sku: "sku_demo_1", price: 12.5 }],
        top_level_new: true,
      }),
      destination(),
      { eventId: "evt-evolve-nested", binding: { table: "events", mode: "nested_records" } },
    );

    expect(out.status).toBe("success");
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse(patchCall!.body!)).toEqual({
      schema: {
        fields: [
          { name: "event", type: "STRING", mode: "REQUIRED", description: "keep event metadata" },
          {
            name: "data",
            type: "RECORD",
            mode: "REQUIRED",
            description: "keep record metadata",
            fields: [
              {
                name: "subscriber",
                type: "RECORD",
                mode: "NULLABLE",
                fields: [
                  { name: "id", type: "STRING", mode: "NULLABLE", description: "stable id" },
                  { name: "email", type: "STRING", mode: "NULLABLE" },
                  {
                    name: "custom_fields",
                    type: "RECORD",
                    mode: "NULLABLE",
                    fields: [{ name: "loyalty_tier", type: "STRING", mode: "NULLABLE" }],
                  },
                ],
              },
              {
                name: "properties",
                type: "RECORD",
                mode: "NULLABLE",
                fields: [
                  { name: "source", type: "STRING", mode: "NULLABLE" },
                  { name: "campaign", type: "STRING", mode: "NULLABLE" },
                ],
              },
            ],
          },
          {
            name: "items",
            type: "RECORD",
            mode: "REPEATED",
            fields: [
              { name: "sku", type: "STRING", mode: "NULLABLE" },
              { name: "price", type: "STRING", mode: "NULLABLE" },
            ],
          },
          { name: "legacy_only", type: "STRING", mode: "NULLABLE" },
          { name: "top_level_new", type: "STRING", mode: "NULLABLE" },
        ],
      },
    });
    expect(calls.filter((call) => call.url.endsWith("/insertAll"))).toHaveLength(2);
    const row = (lastInsertBody as { rows: Array<{ json: Record<string, unknown> }> }).rows[0];
    expect(row.json).toMatchObject({
      data: {
        subscriber: { custom_fields: { loyalty_tier: "3" } },
      },
      items: [{ sku: "sku_demo_1", price: "12.5" }],
      top_level_new: "true",
    });
  });

  it("dead-letters a data-mismatch row (reason=invalid, not a missing field)", async () => {
    insertSeq = [makeRes(200, { insertErrors: [{ index: 0, errors: [{ reason: "invalid", message: "Cannot convert value" }] }] })];
    const out = await deliver(encode({ x: 1 }), destination(), {
      eventId: "evt-2",
      binding: { table: "events", mode: "json_column" },
    });
    expect(out.status).toBe("dead");
  });

  it("enriches a permanent type mismatch with the field and repair choices", async () => {
    insertSeq = [makeRes(200, {
      insertErrors: [{
        index: 0,
        errors: [{ reason: "invalid", message: "Cannot convert value to integer (bad value): 5.69" }],
      }],
    })];
    getTableSeq = [makeRes(200, {
      schema: {
        fields: [{ name: "amount", type: "INT64", mode: "NULLABLE" }],
      },
    })];

    const out = await deliver(encode({ amount: 5.69 }), destination(), {
      eventId: "evt-type-mismatch",
      binding: { table: "events", mode: "typed_records" },
    });

    expect(out.status).toBe("dead");
    expect(out.response).toMatchObject({
      error: expect.stringMatching(/type mismatch at "amount".*FLOAT64.*INT64.*Retrying unchanged data.*rounding rule/),
      schemaMismatches: [
        expect.objectContaining({ path: "amount", expected: "FLOAT64", existing: "INT64" }),
      ],
    });
  });

  it("suggests a text conversion for bool-to-STRING mismatches", async () => {
    insertSeq = [makeRes(200, {
      insertErrors: [{
        index: 0,
        errors: [{ reason: "invalid", message: "Conversion from bool to std::string is unsupported." }],
      }],
    })];
    getTableSeq = [makeRes(200, {
      schema: { fields: [{ name: "active", type: "STRING", mode: "NULLABLE" }] },
    })];

    const out = await deliver(encode({ active: true }), destination(), {
      eventId: "evt-bool-string",
      binding: { table: "events", mode: "typed_records" },
    });

    expect(out.response).toMatchObject({
      error: expect.stringMatching(/"active".*BOOL.*STRING.*Text \(STRING\)/),
    });
  });

  it("suggests a repeated field or explicit array collapse for array-to-scalar mismatches", async () => {
    insertSeq = [makeRes(200, {
      insertErrors: [{
        index: 0,
        errors: [{ reason: "invalid", message: "Array specified for non-repeated field: tags" }],
      }],
    })];
    getTableSeq = [makeRes(200, {
      schema: { fields: [{ name: "tags", type: "STRING", mode: "NULLABLE" }] },
    })];

    const out = await deliver(encode({ tags: ["vip", "wholesale"] }), destination(), {
      eventId: "evt-array-scalar",
      binding: { table: "events", mode: "typed_records" },
    });

    expect(out.response).toMatchObject({
      error: expect.stringMatching(/"tags".*REPEATED STRING.*NULLABLE STRING.*Collapse arrays to text/),
      schemaMismatches: [
        expect.objectContaining({
          path: "tags",
          kind: "mode_conflict",
          expected: "REPEATED STRING",
          existing: "NULLABLE STRING",
        }),
      ],
    });
  });

  it("retries a transient backendError row", async () => {
    insertSeq = [makeRes(200, { insertErrors: [{ index: 0, errors: [{ reason: "backendError" }] }] })];
    const out = await deliver(encode({ x: 1 }), destination(), {
      eventId: "evt-3",
      binding: { table: "events", mode: "json_column" },
    });
    expect(out.status).toBe("retry");
  });

  it("retries a 403 rate-limit but dead-letters a 403 access-denied", async () => {
    insertSeq = [makeRes(403, { error: { message: "rateLimitExceeded" } })];
    const limited = await deliver(encode({}), destination(), { eventId: "e", binding: { table: "events" } });
    expect(limited.status).toBe("retry");

    insertSeq = [makeRes(403, { error: { message: "Access Denied: BigQuery" } })];
    const denied = await deliver(encode({}), destination(), { eventId: "e", binding: { table: "events" } });
    expect(denied.status).toBe("dead");
  });

  it("auto-creates the table on 404, then retries the insert to success", async () => {
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } }), makeRes(200, {})];
    createTableRes = makeRes(200, {});
    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-new",
      binding: { table: "fresh", mode: "json_column" },
    });
    expect(out.status).toBe("success");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/tables"))).toBe(true);
  });

  it("backs off through eventual table propagation after an accepted create", async () => {
    vi.useFakeTimers();
    insertSeq = [
      makeRes(404, { error: { message: "Not found: Table" } }),
      makeRes(404, { error: { message: "Not found: Table" } }),
      makeRes(404, { error: { message: "Not found: Table" } }),
      makeRes(200, {}),
    ];
    createTableRes = makeRes(200, {});

    const pending = deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-create-propagation",
      binding: { table: "fresh", mode: "json_column" },
    });
    await vi.advanceTimersByTimeAsync(400);
    const out = await pending;

    expect(out.status).toBe("success");
    expect(calls.filter((call) => call.url.endsWith("/insertAll"))).toHaveLength(4);
  });

  it("returns retry when an accepted create is still invisible after bounded backoff", async () => {
    vi.useFakeTimers();
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } })];
    createTableRes = makeRes(200, {});

    const pending = deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-create-still-propagating",
      binding: { table: "fresh", mode: "json_column" },
    });
    await vi.advanceTimersByTimeAsync(400);
    const out = await pending;

    expect(out.status).toBe("retry");
    expect(out.response).toMatchObject({ error: "schema_propagation_pending", status: 404 });
    expect(calls.filter((call) => call.url.endsWith("/insertAll"))).toHaveLength(4);
  });

  it("merges desired fields after a concurrent table creator wins with 409", async () => {
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } }), makeRes(200, {})];
    createTableRes = makeRes(409, { error: { message: "Already exists" } });
    getTableSeq = [makeRes(200, {
      etag: "etag-concurrent-create",
      schema: { fields: [{ name: "concurrent", type: "STRING", mode: "NULLABLE" }] },
    })];
    patchSeq = [makeRes(200, {})];

    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-concurrent-create",
      binding: { table: "fresh", mode: "json_column", payload_column: "payload" },
    });

    expect(out.status).toBe("success");
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(patchCall?.headers?.["If-Match"]).toBe("etag-concurrent-create");
    const patchBody = JSON.parse(patchCall!.body!) as { schema: { fields: Array<{ name: string }> } };
    expect(patchBody.schema.fields.map((field) => field.name)).toEqual(["concurrent", "payload"]);
  });

  it("dead-letters a 404 when the table can't be created (e.g. missing perms)", async () => {
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } })];
    createTableRes = makeRes(403, { error: { message: "Permission denied" } });
    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "e",
      binding: { table: "fresh", mode: "json_column" },
    });
    expect(out.status).toBe("dead");
  });

  it("retries a quota-limited table create instead of dead-lettering the original 404", async () => {
    insertSeq = [makeRes(404, { error: { message: "Not found: Table" } })];
    createTableRes = makeRes(403, {
      error: { errors: [{ reason: "rateLimitExceeded" }], message: "Rate limit exceeded" },
    });

    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-create-quota",
      binding: { table: "fresh", mode: "json_column" },
    });

    expect(out.status).toBe("retry");
    expect(out.response).toMatchObject({ error: "schema_repair_transient" });
  });

  it("columns mode: adds missing columns on 'no such field', then retries to success", async () => {
    insertSeq = [
      makeRes(200, {
        kind: "bigquery#tableDataInsertAllResponse",
        insertErrors: [{
          index: 0,
          errors: [{
            reason: "invalid",
            location: "b",
            debugInfo: "",
            message: "no such field: b.",
          }],
        }],
      }),
      makeRes(200, {}),
    ];
    getTableSeq = [makeRes(200, {
      etag: "etag-columns-v1",
      schema: { fields: [{ name: "a", type: "INT64" }] },
    })];
    patchSeq = [makeRes(200, {})];
    const out = await deliver(encode({ a: 1, b: 2 }), destination(), {
      eventId: "evt-evolve",
      binding: { table: "events", mode: "columns" },
    });
    expect(out.status).toBe("success");
    const schemaCalls = calls
      .filter((call) => !call.url.endsWith("/token"))
      .map((call) => ({ method: call.method, url: call.url }));
    expect(schemaCalls.map((call) => call.method)).toEqual(["POST", "GET", "PATCH", "POST"]);
    expect(schemaCalls[0]?.url).toMatch(/\/insertAll$/);
    expect(schemaCalls[1]?.url).toMatch(/\/tables\/events$/);
    expect(schemaCalls[2]?.url).toMatch(/\/tables\/events$/);
    expect(schemaCalls[3]?.url).toMatch(/\/insertAll$/);
    expect(calls.find((call) => call.method === "PATCH")?.headers?.["If-Match"]).toBe("etag-columns-v1");
    const insertCalls = calls.filter((call) => call.url.endsWith("/insertAll"));
    expect(insertCalls).toHaveLength(2);
    for (const call of insertCalls) {
      expect(JSON.parse(call.body!) as { ignoreUnknownValues: boolean }).toMatchObject({
        ignoreUnknownValues: false,
      });
    }
  });

  it("re-GETs, re-merges, and PATCHes with the new ETag after a concurrent 412", async () => {
    insertSeq = [
      makeRes(200, {
        insertErrors: [{
          index: 0,
          errors: [{ reason: "invalid", message: "no such field: b." }],
        }],
      }),
      makeRes(200, {}),
    ];
    getTableSeq = [
      makeRes(200, {
        etag: "etag-v1",
        schema: { fields: [{ name: "a", type: "STRING", mode: "NULLABLE" }] },
      }),
      makeRes(200, {
        etag: "etag-v2",
        schema: {
          fields: [
            { name: "a", type: "STRING", mode: "NULLABLE" },
            { name: "concurrent", type: "STRING", mode: "NULLABLE" },
          ],
        },
      }),
    ];
    patchSeq = [makeRes(412, { error: { message: "Precondition failed" } }), makeRes(200, {})];

    const out = await deliver(encode({ a: 1, b: 2 }), destination(), {
      eventId: "evt-etag-race",
      binding: { table: "events", mode: "columns" },
    });

    expect(out.status).toBe("success");
    const patchCalls = calls.filter((call) => call.method === "PATCH");
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls.map((call) => call.headers?.["If-Match"])).toEqual(["etag-v1", "etag-v2"]);
    const secondPatch = JSON.parse(patchCalls[1]!.body!) as { schema: { fields: Array<{ name: string }> } };
    expect(secondPatch.schema.fields.map((field) => field.name)).toEqual(["a", "concurrent", "b"]);
  });

  it("retries a quota-limited schema PATCH instead of dead-lettering the missing field", async () => {
    insertSeq = [makeRes(200, {
      insertErrors: [{
        index: 0,
        errors: [{ reason: "invalid", message: "no such field: b." }],
      }],
    })];
    getTableSeq = [makeRes(200, {
      etag: "etag-quota-v1",
      schema: { fields: [{ name: "a", type: "STRING", mode: "NULLABLE" }] },
    })];
    patchSeq = [makeRes(403, {
      error: { errors: [{ reason: "quotaExceeded" }], message: "Quota exceeded" },
    })];

    const out = await deliver(encode({ a: 1, b: 2 }), destination(), {
      eventId: "evt-patch-quota",
      binding: { table: "events", mode: "columns" },
    });

    expect(out.status).toBe("retry");
    expect(out.response).toMatchObject({ error: "schema_repair_transient" });
    expect(calls.find((call) => call.method === "PATCH")?.headers?.["If-Match"]).toBe("etag-quota-v1");
  });

  it("treats a concurrent 412 winner that already added the field as ready", async () => {
    insertSeq = [
      makeRes(200, {
        insertErrors: [{
          index: 0,
          errors: [{ reason: "invalid", message: "no such field: b." }],
        }],
      }),
      makeRes(200, {}),
    ];
    getTableSeq = [
      makeRes(200, {
        etag: "etag-v1",
        schema: { fields: [{ name: "a", type: "STRING", mode: "NULLABLE" }] },
      }),
      makeRes(200, {
        etag: "etag-v2",
        schema: {
          fields: [
            { name: "a", type: "STRING", mode: "NULLABLE" },
            { name: "b", type: "STRING", mode: "NULLABLE" },
          ],
        },
      }),
    ];
    patchSeq = [makeRes(412, { error: { message: "Precondition failed" } })];

    const out = await deliver(encode({ a: 1, b: 2 }), destination(), {
      eventId: "evt-etag-winner-ready",
      binding: { table: "events", mode: "columns" },
    });

    expect(out.status).toBe("success");
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("returns retry when a repaired missing field is still propagating after bounded backoff", async () => {
    vi.useFakeTimers();
    insertSeq = [makeRes(200, {
      insertErrors: [{
        index: 0,
        errors: [{ reason: "invalid", message: "no such field: b." }],
      }],
    })];
    getTableSeq = [makeRes(200, {
      etag: "etag-propagation-v1",
      schema: { fields: [{ name: "a", type: "STRING", mode: "NULLABLE" }] },
    })];
    patchSeq = [makeRes(200, {})];

    const pending = deliver(encode({ a: 1, b: 2 }), destination(), {
      eventId: "evt-field-still-propagating",
      binding: { table: "events", mode: "columns" },
    });
    await vi.advanceTimersByTimeAsync(400);
    const out = await pending;

    expect(out.status).toBe("retry");
    expect(out.response).toMatchObject({ error: "schema_propagation_pending", status: 200 });
    expect(calls.filter((call) => call.url.endsWith("/insertAll"))).toHaveLength(4);
  });

  it("patches an empty (schemaless) table on 'has no schema', then retries to success", async () => {
    insertSeq = [
      makeRes(400, {
        error: { code: 400, message: "The destination table has no schema.", errors: [{ reason: "invalid" }] },
      }),
      makeRes(200, {}),
    ];
    getTableSeq = [makeRes(200, { etag: "etag-empty-v1", schema: { fields: [] } })];
    patchSeq = [makeRes(200, {})];
    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-schemaless",
      binding: { table: "data-temp", mode: "json_column", payload_column: "payload" },
    });
    expect(out.status).toBe("success");
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("retries a 500", async () => {
    insertSeq = [makeRes(503, "backend unavailable")];
    const out = await deliver(encode({}), destination(), { eventId: "e", binding: { table: "events" } });
    expect(out.status).toBe("retry");
  });

  it("dead-letters when no binding and no config.table", async () => {
    const out = await deliver(encode({}), destination(), { eventId: "e" });
    expect(out.status).toBe("dead");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dead-letters columns mode when the body is not a JSON object", async () => {
    const bad = new TextEncoder().encode("not json").buffer;
    const out = await deliver(bad, destination(), { eventId: "e", binding: { table: "events", mode: "columns" } });
    expect(out.status).toBe("dead");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dead-letters when the credential is missing", async () => {
    const out = await deliver(encode({}), destination({ service_account_json: undefined }), {
      eventId: "e",
      binding: { table: "events" },
    });
    expect(out.status).toBe("dead");
  });

  it("accepts a hyphenated table name (BigQuery allows them, e.g. data-temp)", async () => {
    const out = await deliver(encode({ a: 1 }), destination(), {
      eventId: "e",
      binding: { table: "data-temp", mode: "json_column" },
    });
    expect(out.status).toBe("success");
    expect(calls.some((c) => c.url.includes("/tables/data-temp/insertAll"))).toBe(true);
  });

  it("accepts a 1024-character table binding but rejects 1025 characters", async () => {
    const valid = "a".repeat(1024);
    const accepted = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-table-max",
      binding: { table: valid, mode: "json_column" },
    });
    expect(accepted.status).toBe("success");

    fetchMock.mockClear();
    const rejected = await deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-table-too-long",
      binding: { table: `${valid}a`, mode: "json_column" },
    });
    expect(rejected.status).toBe("dead");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to config.table when the route has no binding", async () => {
    const out = await deliver(encode({ a: 1 }), destination({ table: "legacy_events" }), { eventId: "evt-legacy" });
    expect(out.status).toBe("success");
    expect(calls.some((c) => c.url.includes("/tables/legacy_events/insertAll"))).toBe(true);
  });
});
