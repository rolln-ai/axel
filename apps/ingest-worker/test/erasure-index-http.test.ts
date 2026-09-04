import { describe, expect, it, vi } from "vitest";
import {
  ErasureIndexUnavailableError,
  indexErasureSubjectsFromDeliveryService,
  type ErasureIndexFetch,
} from "../src/erasure-index-http.js";

const ENV = {
  DELIVERY_SERVICE_URL: "https://delivery.example/",
  SOURCE_LOOKUP_SHARED_SECRET: "erasure-index-test-secret", // gitleaks:allow
};
const SUBJECT_ID = `sub_${"a".repeat(64)}`;

function response(body: unknown, status: number = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("delivery-service erasure index client", () => {
  it("sends a bounded authenticated request without a database credential or workspace override", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => (
      response({ ok: true })
    ));
    await indexErasureSubjectsFromDeliveryService(
      ENV,
      "src_1",
      [SUBJECT_ID],
      "evt_1",
      "events/ws_1/2026-08-27/evt_1",
      "2026-08-27T20:00:00.000Z",
      fetchMock as ErasureIndexFetch,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://delivery.example/internal/erasure-subjects");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-axel-shared-secret": "erasure-index-test-secret",
      },
    });
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      source_id: "src_1",
      subject_ids: [SUBJECT_ID],
      event_id: "evt_1",
      r2_key: "events/ws_1/2026-08-27/evt_1",
      received_at: "2026-08-27T20:00:00.000Z",
    });
    expect(body).not.toHaveProperty("workspace_id");
    expect(JSON.stringify(init)).not.toContain("DATABASE_URL");
  });

  it("uses the delivery credential only as the existing bootstrap fallback", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => (
      response({ ok: true })
    ));
    await indexErasureSubjectsFromDeliveryService(
      {
        DELIVERY_SERVICE_URL: ENV.DELIVERY_SERVICE_URL,
        DELIVERY_SHARED_SECRET: "delivery-bootstrap-secret", // gitleaks:allow
      },
      "src_1",
      [SUBJECT_ID],
      "evt_1",
      "events/ws_1/2026-08-27/evt_1",
      "2026-08-27T20:00:00.000Z",
      fetchMock as ErasureIndexFetch,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "x-axel-shared-secret": "delivery-bootstrap-secret" },
    });
  });

  it("does not call the service when the source resolved no subjects", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => (
      response({ ok: true })
    ));
    await indexErasureSubjectsFromDeliveryService(
      ENV,
      "src_1",
      [],
      "evt_1",
      "events/ws_1/2026-08-27/evt_1",
      "2026-08-27T20:00:00.000Z",
      fetchMock as ErasureIndexFetch,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing configuration", {}, undefined],
    ["network failure", ENV, async () => { throw new Error("connection failed"); }],
    ["server rejection", ENV, async () => response({ ok: false }, 503)],
    ["invalid JSON", ENV, async () => response("not-json")],
    ["invalid success envelope", ENV, async () => response({ ok: false })],
  ])("fails closed on %s", async (_label, env, fetchImpl) => {
    await expect(indexErasureSubjectsFromDeliveryService(
      env,
      "src_1",
      [SUBJECT_ID],
      "evt_1",
      "events/ws_1/2026-08-27/evt_1",
      "2026-08-27T20:00:00.000Z",
      fetchImpl as ErasureIndexFetch | undefined,
    )).rejects.toBeInstanceOf(ErasureIndexUnavailableError);
  });

  it.each([
    "http://delivery.example",
    "https://user:password@delivery.example",
    "https://delivery.example/prefix",
    "https://delivery.example#fragment",
  ])("rejects an unsafe service URL before sending the credential: %s", async (url) => {
    const fetchMock = vi.fn();
    await expect(indexErasureSubjectsFromDeliveryService(
      { ...ENV, DELIVERY_SERVICE_URL: url },
      "src_1",
      [SUBJECT_ID],
      "evt_1",
      "events/ws_1/2026-08-27/evt_1",
      "2026-08-27T20:00:00.000Z",
      fetchMock as ErasureIndexFetch,
    )).rejects.toBeInstanceOf(ErasureIndexUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized response", async () => {
    await expect(indexErasureSubjectsFromDeliveryService(
      ENV,
      "src_1",
      [SUBJECT_ID],
      "evt_1",
      "events/ws_1/2026-08-27/evt_1",
      "2026-08-27T20:00:00.000Z",
      (async () => response({ padding: "x".repeat(64 * 1024) })) as ErasureIndexFetch,
    )).rejects.toBeInstanceOf(ErasureIndexUnavailableError);
  });
});
