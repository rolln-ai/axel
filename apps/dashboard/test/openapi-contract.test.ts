/**
 * Contract tests for the OpenAPI spec at public/openapi.yaml.
 *
 * Calls each /api/v1 route handler with a mocked DB + auth, then
 * validates the response body against the documented schema. When
 * a handler's response shape drifts, the matching spec branch fails
 * and CI tells you to update public/openapi.yaml.
 *
 * Companion file: openapi-coverage.test.ts asserts every route
 * handler is documented (and vice versa).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { NextRequest } from "next/server";

vi.mock("../lib/db", () => {
  const query = vi.fn();
  return {
    db: vi.fn(() => ({ query })),
    withTransaction: vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => (
      fn({ query })
    )),
    hasDatabaseUrl: () => true,
  };
});

// The REST replay route now applies the billing gate (like the server actions);
// stub it to "allowed" so these schema tests don't need to script its billing query.
vi.mock("../lib/auth-guards", () => ({
  replayBillingGateError: async () => null,
}));

vi.mock("../lib/api-keys", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-keys")>(
    "../lib/api-keys",
  );
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
  };
});

vi.mock("../lib/ids", () => ({
  prefixedId: (prefix: string) => `${prefix}_testid01`,
}));

vi.mock("../lib/source-tokens", () => ({
  generateSourceToken: () => ({
    plaintext: "axt_testplaintexttokenvalue",
    hash: "deadbeef".repeat(8),
  }),
}));

// withApiAuth now rate-limits the /api/v1 auth path (ROL-204), which issues a
// Postgres upsert per request. This schema-contract test scripts db responses in
// a strict per-request sequence, so that extra query would consume a scripted
// row and shift every assertion. Rate limiting isn't what this suite tests —
// stub it to "never limited" so it stays out of the query sequence.
vi.mock("../lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("../lib/rate-limit")>("../lib/rate-limit");
  return { ...actual, enforceAuthRateLimits: vi.fn(async () => null) };
});

import * as db from "../lib/db";
import * as apiKeys from "../lib/api-keys";
import * as sourcesRoute from "../app/api/v1/sources/route";
import * as destinationsRoute from "../app/api/v1/destinations/route";
import * as routesRoute from "../app/api/v1/routes/route";
import * as configRoute from "../app/api/v1/config/route";
import * as usageRoute from "../app/api/v1/usage/route";
import * as replaysRoute from "../app/api/v1/replays/route";

type AnyObj = Record<string, unknown>;

const SPEC_PATH = resolve(__dirname, "..", "public", "openapi.yaml");
const SPEC = parseYaml(readFileSync(SPEC_PATH, "utf8")) as AnyObj;

/**
 * Recursive `#/...` $ref resolver. Cycle-safe via a visited set.
 * Inlines refs so ajv sees a self-contained schema per response —
 * cheaper than wiring ajv's $ref resolver to the full document.
 */
function deref<T>(node: T, seen: Set<string> = new Set()): T {
  if (Array.isArray(node)) return node.map((n) => deref(n, seen)) as unknown as T;
  if (node && typeof node === "object") {
    const obj = node as AnyObj;
    if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/")) {
      if (seen.has(obj.$ref)) return {} as T;
      const nextSeen = new Set(seen).add(obj.$ref);
      const target = obj.$ref
        .slice(2)
        .split("/")
        .reduce<unknown>((acc, k) => (acc as AnyObj)?.[k], SPEC);
      return deref(target, nextSeen) as T;
    }
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deref(v, seen);
    return out as T;
  }
  return node;
}

/**
 * Walk a dereferenced schema and set `additionalProperties: false`
 * on every object schema that doesn't already specify it. JSON
 * Schema is open-world by default, so without this an added field
 * in a handler response would pass validation silently — defeating
 * the whole point of contract testing.
 *
 * Schemas that explicitly opt into `additionalProperties: true`
 * (e.g. ExportedConfig items, which deliberately pass through
 * arbitrary connector config) are preserved as-is.
 */
function strictifyObjects<T>(node: T): T {
  if (Array.isArray(node)) return node.map(strictifyObjects) as unknown as T;
  if (node && typeof node === "object") {
    const obj = node as AnyObj;
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(obj)) out[k] = strictifyObjects(v);
    if (
      (out.type === "object" || out.properties !== undefined) &&
      out.additionalProperties === undefined
    ) {
      out.additionalProperties = false;
    }
    return out as T;
  }
  return node;
}

// OpenAPI 3.1 uses JSON Schema 2020-12. Use ajv's 2020 build so $defs,
// type arrays, and unevaluatedProperties parse cleanly.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

function responseValidator(opPath: string, method: string, status: string) {
  const pathItem = SPEC.paths as AnyObj;
  const op = (pathItem[opPath] as AnyObj)?.[method.toLowerCase()] as AnyObj | undefined;
  if (!op) throw new Error(`No operation: ${method} ${opPath}`);
  const rawResponse = (op.responses as AnyObj)[status];
  if (!rawResponse) throw new Error(`No response for ${method} ${opPath} ${status}`);
  // Response-level $refs (to components/responses/*) need resolving
  // before we can dig into .content.
  const resolved = deref(rawResponse) as AnyObj;
  const mediaType = (resolved.content as AnyObj | undefined)?.[
    "application/json"
  ] as AnyObj | undefined;
  const schema = mediaType?.schema;
  if (!schema) throw new Error(`No JSON schema for ${method} ${opPath} ${status}`);
  return ajv.compile(strictifyObjects(deref(schema)));
}

function fakeAuth(scopes: string[] = ["admin"]): void {
  (apiKeys.authenticateApiKey as Mock).mockResolvedValue({
    workspace_id: "ws_test",
    key_id: "key_test",
    scopes,
  });
}

function fakeAuthMissing(): void {
  (apiKeys.authenticateApiKey as Mock).mockResolvedValue(null);
}

function dbMock(): Mock {
  return (db.db() as unknown as { query: Mock }).query;
}

function queueRows(...batches: unknown[][]): Mock {
  const q = dbMock();
  q.mockReset();
  for (const rows of batches) {
    q.mockResolvedValueOnce({ rows, rowCount: rows.length });
  }
  return q;
}

function req(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock().mockReset();
});

describe("OpenAPI spec — structural", () => {
  it("declares OpenAPI 3.1.x", () => {
    expect(String(SPEC.openapi)).toMatch(/^3\.1/);
  });

  it("declares both security schemes used by /api/v1 and ingest", () => {
    const schemes = (SPEC.components as AnyObj).securitySchemes as AnyObj;
    expect(schemes.WorkspaceBearer).toBeDefined();
    expect(schemes.SourceToken).toBeDefined();
  });
});

describe("GET /api/v1/sources", () => {
  it("200 list response matches schema", async () => {
    fakeAuth(["read"]);
    queueRows([
      {
        id: "src_8c12af",
        name: "stripe-webhooks-prod",
        status: "active",
        created_at: "2026-05-01T00:00:00Z",
      },
    ]);
    const res = await sourcesRoute.GET(
      req("http://t/api/v1/sources", { headers: { authorization: "Bearer axl_x" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const validate = responseValidator("/api/v1/sources", "get", "200");
    if (!validate(body)) {
      throw new Error(
        `Response drift: ${ajv.errorsText(validate.errors, { separator: "\n  " })}`,
      );
    }
  });

  it("401 unauthenticated matches the documented Error envelope", async () => {
    fakeAuthMissing();
    const res = await sourcesRoute.GET(req("http://t/api/v1/sources"));
    expect(res.status).toBe(401);
    const body = await res.json();
    const validate = responseValidator("/api/v1/sources", "get", "401");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }
  });
});

describe("POST /api/v1/sources", () => {
  it("201 create response matches schema", async () => {
    fakeAuth(["write"]);
    queueRows(
      [{ status: "active" }], // workspace liveness lock
      [], // dup-name check → 0 rows
      [], // insert sources
      [], // insert audit_log
    );
    const res = await sourcesRoute.POST(
      req("http://t/api/v1/sources", {
        method: "POST",
        headers: {
          authorization: "Bearer axl_x",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "stripe-webhooks-prod" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    const validate = responseValidator("/api/v1/sources", "post", "201");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }

    expect(db.withTransaction as Mock).toHaveBeenCalledOnce();
    const sql = dbMock().mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toMatch(/FROM workspaces[\s\S]*FOR UPDATE/i);
    expect(sql.findIndex((statement) => /FROM sources[\s\S]*lower\(name\)/i.test(statement))).toBe(1);
    expect(sql.findIndex((statement) => /INSERT INTO sources/i.test(statement))).toBe(2);
    expect(sql.findIndex((statement) => /INSERT INTO audit_log/i.test(statement))).toBe(3);
  });

  it("409s without inserting when the locked workspace is no longer active", async () => {
    fakeAuth(["write"]);
    queueRows([{ status: "suspended" }]);

    const res = await sourcesRoute.POST(
      req("http://t/api/v1/sources", {
        method: "POST",
        headers: {
          authorization: "Bearer axl_x",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "stripe-webhooks-prod" }),
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Workspace is not active. Source was not created.",
      code: "workspace_inactive",
    });
    expect(db.withTransaction as Mock).toHaveBeenCalledOnce();
    expect(dbMock()).toHaveBeenCalledOnce();
    expect(String(dbMock().mock.calls[0]?.[0])).toMatch(/FROM workspaces[\s\S]*FOR UPDATE/i);
  });

  it("400 invalid_name matches Error envelope", async () => {
    fakeAuth(["write"]);
    const res = await sourcesRoute.POST(
      req("http://t/api/v1/sources", {
        method: "POST",
        headers: {
          authorization: "Bearer axl_x",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "x" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    const validate = responseValidator("/api/v1/sources", "post", "400");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }
  });
});

describe("GET /api/v1/destinations", () => {
  it("200 list response matches schema", async () => {
    fakeAuth(["read"]);
    queueRows([
      {
        id: "dst_a91f02",
        name: "prod-warehouse",
        type: "webhook",
        status: "active",
        circuit_state: "closed",
        delivery_paused: false,
        created_at: "2026-05-01T00:00:00Z",
      },
    ]);
    const res = await destinationsRoute.GET(
      req("http://t/api/v1/destinations", {
        headers: { authorization: "Bearer axl_x" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const validate = responseValidator("/api/v1/destinations", "get", "200");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }
  });
});

describe("GET /api/v1/routes", () => {
  it("200 list response matches schema", async () => {
    fakeAuth(["read"]);
    queueRows([
      {
        id: "rte_2c01dd",
        source_id: "src_8c12af",
        status: "active",
        created_at: "2026-05-01T00:00:00Z",
      },
    ]);
    const res = await routesRoute.GET(
      req("http://t/api/v1/routes", {
        headers: { authorization: "Bearer axl_x" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const validate = responseValidator("/api/v1/routes", "get", "200");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }
  });
});

describe("GET /api/v1/usage", () => {
  it("200 usage response matches schema", async () => {
    fakeAuth(["read"]);
    queueRows(
      [{ n: 3 }], // sources
      [{ n: 2 }], // destinations
      [{ n: 0 }], // dead_letters
    );
    const res = await usageRoute.GET(
      req("http://t/api/v1/usage", {
        headers: { authorization: "Bearer axl_x" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const validate = responseValidator("/api/v1/usage", "get", "200");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }
  });
});

describe("GET /api/v1/config", () => {
  it("200 export response matches schema", async () => {
    fakeAuth(["admin"]);
    queueRows(
      [
        {
          id: "src_8c12af",
          name: "stripe-webhooks-prod",
          status: "active",
          provider: "stripe",
          max_body_bytes: 1_048_576,
          max_body_depth: 100,
          max_events_per_minute: null,
          field_selection: null,
          inbound_ip_allowlist: [],
          transient_mode: false,
          raw_payload_retention_days: 90,
        },
      ],
      [
        {
          id: "dst_a91f02",
          name: "prod-warehouse",
          type: "webhook",
          status: "active",
          config: {
            url: "https://example.com/hooks/url-private-marker?token=query-private-marker",
            headers: {
              "X-Custom-Context": "header-private-marker",
              Authorization: "auth-private-marker",
            },
          },
          credentials_ref: null,
          rate_limit_rps: null,
          request_timeout_ms: 30_000,
          circuit_threshold_failures: 5,
          circuit_cooldown_seconds: 60,
        },
      ],
      [
        {
          id: "rte_2c01dd",
          source_id: "src_8c12af",
          status: "active",
          filter_expression: null,
          transform_script: null,
          engine: "v1",
        },
      ],
      [{
        route_id: "rte_2c01dd",
        destination_id: "dst_a91f02",
        binding: { dataset: "analytics", table: "events" },
      }],
    );
    const res = await configRoute.GET(
      req("http://t/api/v1/config", {
        headers: { authorization: "Bearer axl_x" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      destinations: Array<{ config: Record<string, unknown> }>;
      routes: Array<{
        destination_ids: string[];
        destination_bindings: Record<string, Record<string, unknown> | null>;
      }>;
    };
    const validate = responseValidator("/api/v1/config", "get", "200");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }
    expect(body.routes[0]).toMatchObject({
      destination_ids: ["dst_a91f02"],
      destination_bindings: {
        dst_a91f02: { dataset: "analytics", table: "events" },
      },
    });
    expect(body.destinations[0]?.config).toEqual({
      url: "[REDACTED]",
      headers: {
        "X-Custom-Context": "[REDACTED]",
        Authorization: "[REDACTED]",
      },
    });
    const serialized = JSON.stringify(body.destinations);
    for (const marker of [
      "url-private-marker",
      "query-private-marker",
      "header-private-marker",
      "auth-private-marker",
    ]) {
      expect(serialized).not.toContain(marker);
    }
  });
});

describe("POST /api/v1/replays", () => {
  it("202 enqueue response matches schema", async () => {
    fakeAuth(["replay"]);
    queueRows(
      [
        // enqueueReplays candidate-evaluation row (dead_letter lookup with
        // mute / in-flight flags computed inline).
        {
          event_id: "01935b3e-2c08-7c00-8000-c8a1b1e9d2f7",
          source_id: "src_8c12af",
          r2_key: "events/ws/2026/abc",
          scope: "all",
          route_id: null,
          destination_id: null,
          failure_reason: "router_processing_failed",
          is_muted: false,
          is_in_flight: false,
        },
      ],
      [{ id: "rpy_openapi_1" }], // insert replay_requests RETURNING id
      [], // insert audit_log
    );
    const res = await replaysRoute.POST(
      req("http://t/api/v1/replays", {
        method: "POST",
        headers: {
          authorization: "Bearer axl_x",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_id: "01935b3e-2c08-7c00-8000-c8a1b1e9d2f7" }),
      }),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    const validate = responseValidator("/api/v1/replays", "post", "202");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }
  });

  it("404 not_found matches Error envelope when no dead-letter row exists", async () => {
    fakeAuth(["replay"]);
    queueRows([]); // dead_letter lookup → no row
    const res = await replaysRoute.POST(
      req("http://t/api/v1/replays", {
        method: "POST",
        headers: {
          authorization: "Bearer axl_x",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_id: "01935b3e-2c08-7c00-8000-c8a1b1e9d2f7" }),
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    const validate = responseValidator("/api/v1/replays", "post", "404");
    if (!validate(body)) {
      throw new Error(ajv.errorsText(validate.errors));
    }
  });
});
