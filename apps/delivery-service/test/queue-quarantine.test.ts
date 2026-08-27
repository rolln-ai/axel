import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { recordQueueQuarantine } from "../src/queue-quarantine.ts";

describe("recordQueueQuarantine", () => {
  it("stores a stable fingerprint and safe metadata, never the queue body or lease", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as pg.Pool;
    const body = JSON.stringify({ authorization: "Bearer webhook-secret", payload: { ssn: "123-45-6789" } });

    await recordQueueQuarantine(pool, {
      queueName: "delivery-service",
      message: {
        id: "message_1",
        lease_id: "secret-lease-id",
        attempts: 2,
        timestamp_ms: Date.parse("2026-08-27T12:00:00.000Z"),
        body,
        metadata: { "CF-Content-Type": "json" },
      },
      failure: { code: "missing_field", field: "route_id" },
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    const rendered = JSON.stringify([sql, params]);
    expect(rendered).not.toContain("webhook-secret");
    expect(rendered).not.toContain("123-45-6789");
    expect(rendered).not.toContain("secret-lease-id");
    expect(params).toContain(createHash("sha256").update(body).digest("hex"));
    expect(params).toContain("missing_field");
    expect(params).toContain("route_id");
  });

  it("falls back to a body hash when Cloudflare omits its message id", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as pg.Pool;

    await recordQueueQuarantine(pool, {
      queueName: "delivery-service",
      message: {
        id: "",
        lease_id: "lease",
        body: "not-json",
      },
      failure: { code: "invalid_json" },
    });

    const params = query.mock.calls[0]![1];
    expect(params[1]).toMatch(/^body:[0-9a-f]{64}$/);
  });
});
