import { afterEach, describe, expect, it, vi } from "vitest";
import { markRouteErrored } from "../src/index.ts";

/**
 * Pins drift decision (b) on the edge side: engine failures report the route
 * errored through delivery-service `/internal/routes/errored`, so a bad graph
 * auto-disables the route on live traffic exactly as the Node router's
 * handleBreach does on replay.
 */
describe("markRouteErrored", () => {
  afterEach(() => vi.restoreAllMocks());

  const env = {
    DELIVERY_SERVICE_URL: "https://delivery.example/",
    DELIVERY_SHARED_SECRET: "shh",
  };

  it("POSTs the breach to /internal/routes/errored with shared-secret auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await markRouteErrored(env, "ws-1", "rt-1", {
      reason: "filter_invalid_json",
      message: "boom",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://delivery.example/internal/routes/errored",
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: expect.objectContaining({ "x-axel-shared-secret": "shh" }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      workspace_id: "ws-1",
      route_id: "rt-1",
      reason: "filter_invalid_json",
      message: "boom",
    });
  });

  it("throws on a non-2xx so the caller can log it (best-effort at the call site)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      markRouteErrored(env, "ws-1", "rt-1", { reason: "r", message: "m" }),
    ).rejects.toThrow(/internal_routes_errored_500/);
  });

  it("throws when the delivery-service wiring is missing", async () => {
    await expect(
      markRouteErrored({}, "ws-1", "rt-1", { reason: "r", message: "m" }),
    ).rejects.toThrow(/not configured/);
  });

  it("rejects an unsafe service URL before sending the credential", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(markRouteErrored(
      {
        DELIVERY_SERVICE_URL: "https://user:password@delivery.example",
        DELIVERY_SHARED_SECRET: "shh",
      },
      "ws-1",
      "rt-1",
      { reason: "r", message: "m" },
    )).rejects.toThrow(/internal_service_url_invalid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
