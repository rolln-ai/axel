import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../lib/db", () => ({ db: () => ({ query: queryMock }) }));

import { GET } from "../app/api/ops/delivery-canary/receipt/route";

const TOKEN = "canary-receipt-token-that-is-long-enough";
const PROBE_ID = "axel_canary_1787852700000_012345abcdef";
const ORIGINAL_TOKEN = process.env.DELIVERY_CANARY_RECEIPT_TOKEN;

function request(options: { token?: string; probe?: string } = {}): Request {
  const url = new URL("https://app.axelapp.ai/api/ops/delivery-canary/receipt");
  if (options.probe !== undefined) url.searchParams.set("probe", options.probe);
  return new Request(url, {
    headers: options.token ? { "x-axel-canary-token": options.token } : {},
  });
}

describe("delivery canary receipt endpoint", () => {
  beforeEach(() => {
    process.env.DELIVERY_CANARY_RECEIPT_TOKEN = TOKEN;
    queryMock.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.DELIVERY_CANARY_RECEIPT_TOKEN;
    else process.env.DELIVERY_CANARY_RECEIPT_TOKEN = ORIGINAL_TOKEN;
  });

  it("hides the endpoint and skips Postgres when authentication fails", async () => {
    const responses = await Promise.all([
      GET(request({ probe: PROBE_ID })),
      GET(request({ token: "wrong", probe: PROBE_ID })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("fails closed when the configured token is shorter than 32 characters", async () => {
    process.env.DELIVERY_CANARY_RECEIPT_TOKEN = "short";

    const response = await GET(request({ token: "short", probe: PROBE_ID }));

    expect(response.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects malformed probe identifiers before querying Postgres", async () => {
    const response = await GET(request({ token: TOKEN, probe: "../customer-events" }));

    expect(response.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns only the matching probe identifier and receipt time", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          probe_id: PROBE_ID,
          received_at: new Date("2026-08-27T18:25:00.000Z"),
          payload: { customer_secret: "must-not-leak" },
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 });

    const response = await GET(request({ token: TOKEN, probe: PROBE_ID }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      probe_id: PROBE_ID,
      received_at: "2026-08-27T18:25:00.000Z",
    });
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/SELECT[\s\S]+payload ->> 'axel_canary_probe_id'[\s\S]+LIMIT 1/),
      [PROBE_ID],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/DELETE FROM delivery_canary_receipts[\s\S]+interval '7 days'/),
    );
  });

  it("does not expose whether a valid probe is missing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await GET(request({ token: TOKEN, probe: PROBE_ID }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it("still returns a receipt when best-effort pruning fails", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ probe_id: PROBE_ID, received_at: "2026-08-27T18:25:00.000Z" }],
        rowCount: 1,
      })
      .mockRejectedValueOnce(new Error("prune unavailable"));

    const response = await GET(request({ token: TOKEN, probe: PROBE_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      probe_id: PROBE_ID,
      received_at: "2026-08-27T18:25:00.000Z",
    });
  });

  it("returns a generic error without database details when lookup fails", async () => {
    queryMock.mockRejectedValueOnce(new Error("password=do-not-leak"));

    const response = await GET(request({ token: TOKEN, probe: PROBE_ID }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "receipt_lookup_unavailable" });
  });

  it("fails closed when a stored receipt timestamp is invalid", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ probe_id: PROBE_ID, received_at: "invalid-date" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await GET(request({ token: TOKEN, probe: PROBE_ID }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "receipt_lookup_unavailable" });
  });
});
