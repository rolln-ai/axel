import { afterEach, describe, expect, it, vi } from "vitest";
import { insertRows } from "../src/clickhouse-insert.js";

describe("ClickHouse insert diagnostics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not log a response that echoes submitted event metadata", async () => {
    const secret = "authorization=Bearer webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`Cannot parse row: ${secret}`, { status: 400 })),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await insertRows(
      { CLICKHOUSE_URL: "https://clickhouse.example.test" },
      "events",
      [{ headers_json: secret }],
    );

    expect(error).toHaveBeenCalledWith("[clickhouse] events insert 400");
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });

  it("does not log a transport exception carrying the request body", async () => {
    const secret = "one-shot-webhook-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(secret);
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await insertRows(
      { CLICKHOUSE_URL: "https://clickhouse.example.test" },
      "delivery_attempts",
      [{ response: secret }],
    );

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[clickhouse] delivery_attempts insert transport failed after 3 attempts",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });
});
