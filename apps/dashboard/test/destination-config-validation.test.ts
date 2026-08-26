import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturingPg, fakeSession } from "@axel/test-utils";
import {
  destinationSelectOptionsError,
  isDestinationFieldVisible,
  schemaFor,
} from "../lib/destination-defaults";

// Style B (module mock): exercise updateDestination / createDestination
// against a capturing fake { query } injected via the mocked db, asserting
// that select-kind config values are validated against the schema's option
// allow-list and that `showWhen`-hidden config keys are dropped on update.
// No real Postgres.

const pg = capturingPg();
const { calls: pgCalls, responses: pgResponses } = pg;

vi.mock("../lib/db", () => pg.dbModule());

vi.mock("../lib/session", () => ({
  requireSession: async () => fakeSession("owner"),
}));

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Map(),
  cookies: async () => ({ get: () => undefined }),
}));

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("destinationSelectOptionsError", () => {
  it("rejects a value outside a select field's options", () => {
    const error = destinationSelectOptionsError("webhook", { signing_algorithm: "sha512" });
    expect(error).toMatch(/Signing algorithm must be one of: hmac-sha256, hmac-sha512/);
  });

  it("accepts every declared option value", () => {
    for (const schema of [schemaFor("webhook"), schemaFor("http"), schemaFor("s3")]) {
      for (const field of schema.fields) {
        if (field.inputType !== "select" || !field.options) continue;
        for (const opt of field.options) {
          expect(destinationSelectOptionsError(schema.type, { [field.key]: opt.value })).toBeNull();
        }
      }
    }
  });

  it("skips empty/absent values (required-ness is enforced separately)", () => {
    expect(destinationSelectOptionsError("webhook", {})).toBeNull();
    expect(destinationSelectOptionsError("webhook", { signing_algorithm: "" })).toBeNull();
  });

  it("ignores non-select fields entirely", () => {
    expect(destinationSelectOptionsError("webhook", { url: "not-an-option" })).toBeNull();
  });
});

describe("isDestinationFieldVisible", () => {
  const httpFields = schemaFor("http").fields;
  const apiKeyHeader = httpFields.find((f) => f.key === "api_key_header")!;
  const url = httpFields.find((f) => f.key === "url")!;

  it("always shows fields without showWhen", () => {
    expect(isDestinationFieldVisible(url, {})).toBe(true);
  });

  it("shows a conditional field only while its controlling value matches", () => {
    expect(isDestinationFieldVisible(apiKeyHeader, { auth_type: "api_key" })).toBe(true);
    expect(isDestinationFieldVisible(apiKeyHeader, { auth_type: "bearer" })).toBe(false);
    expect(isDestinationFieldVisible(apiKeyHeader, {})).toBe(false);
  });
});

describe("updateDestination — select option validation", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
  });

  it("rejects an enum typo instead of storing it", async () => {
    // (1) type/config lookup
    pgResponses.push({
      rows: [
        {
          type: "webhook",
          config: { url: "https://api.example.com/hooks", signing_algorithm: "hmac-sha256" },
        },
      ],
      rowCount: 1,
    });

    const { updateDestination } = await import("../lib/destination-actions");
    const result = await updateDestination(
      {},
      formData({
        destination_id: "dst_1",
        url: "https://api.example.com/hooks",
        // The exact typo from the audit finding — the webhook connector's
        // `algorithm === "hmac-sha512" ? "SHA-512" : "SHA-256"` switch would
        // silently sign with SHA-256 if this were stored.
        signing_algorithm: "sha512",
      }),
    );

    expect(result.error).toMatch(/Signing algorithm must be one of: hmac-sha256, hmac-sha512/);
    expect(pgCalls.some((c) => /UPDATE destinations/.test(c.sql))).toBe(false);
  });

  it("accepts a valid enum value and stores it", async () => {
    pgResponses.push({
      rows: [
        {
          type: "webhook",
          config: { url: "https://api.example.com/hooks", signing_algorithm: "hmac-sha256" },
        },
      ],
      rowCount: 1,
    });
    pgResponses.push({ rows: [], rowCount: 1 }); // UPDATE destinations
    pgResponses.push({ rows: [], rowCount: 1 }); // audit_log INSERT

    const { updateDestination } = await import("../lib/destination-actions");
    const result = await updateDestination(
      {},
      formData({
        destination_id: "dst_1",
        url: "https://api.example.com/hooks",
        signing_algorithm: "hmac-sha512",
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.notice).toMatch(/Destination updated/);
    const update = pgCalls.find((c) => /UPDATE destinations/.test(c.sql));
    expect(update).toBeDefined();
    const storedConfig = JSON.parse(update!.params[1] as string) as Record<string, unknown>;
    expect(storedConfig.signing_algorithm).toBe("hmac-sha512");
  });

  it("drops showWhen-hidden config keys when the controlling value changes", async () => {
    pgResponses.push({
      rows: [
        {
          type: "http",
          config: {
            url: "https://api.example.com/in",
            auth_type: "api_key",
            api_key_header: "X-API-Key",
          },
        },
      ],
      rowCount: 1,
    });
    pgResponses.push({ rows: [], rowCount: 1 }); // UPDATE destinations
    pgResponses.push({ rows: [], rowCount: 1 }); // audit_log INSERT

    const { updateDestination } = await import("../lib/destination-actions");
    // The form hides api_key_header once auth_type is "bearer", so it isn't
    // submitted — the stale stored value must not survive the merge.
    const result = await updateDestination(
      {},
      formData({
        destination_id: "dst_1",
        url: "https://api.example.com/in",
        auth_type: "bearer",
      }),
    );

    expect(result.error).toBeUndefined();
    const update = pgCalls.find((c) => /UPDATE destinations/.test(c.sql));
    const storedConfig = JSON.parse(update!.params[1] as string) as Record<string, unknown>;
    expect(storedConfig.auth_type).toBe("bearer");
    expect(storedConfig.api_key_header).toBeUndefined();
  });
});

describe("createDestination — select option validation", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
  });

  it("rejects an enum typo before any insert", async () => {
    const { createDestination } = await import("../lib/destination-actions");
    const result = await createDestination(
      {},
      formData({
        type: "webhook",
        name: "prod hooks",
        url: "https://api.example.com/hooks",
        signing_algorithm: "sha512",
      }),
    );

    expect(result.error).toMatch(/Signing algorithm must be one of: hmac-sha256, hmac-sha512/);
    expect(pgCalls.some((c) => /INSERT INTO destinations/.test(c.sql))).toBe(false);
  });
});
