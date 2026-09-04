import { describe, expect, it, vi } from "vitest";
import { recordHeartbeatHttp } from "../src/heartbeat.ts";

describe("HTTP heartbeat authentication", () => {
  it("disables redirects before attaching the shared secret", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await recordHeartbeatHttp(
      "https://delivery.example/internal/heartbeat",
      "shared-secret",
      { component: "router", tickCount: 1 },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://delivery.example/internal/heartbeat",
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: expect.objectContaining({ "x-axel-shared-secret": "shared-secret" }),
      }),
    );
  });

  it("drops identifiers and free-form strings before telemetry egress", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await recordHeartbeatHttp(
      "https://delivery.example/internal/heartbeat",
      "shared-secret",
      {
        component: "router-edge",
        tickCount: 2,
        error: "receiver echoed customer-marker@example.com",
        metadata: {
          backlog: 4,
          healthy: false,
          event_id: "event-private-marker",
          nested: { count: 1, response: "provider-private-marker" },
        },
      },
      { fetchImpl },
    );

    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.error).toBe("operation_failed");
    expect(body.metadata).toEqual({ backlog: 4, healthy: false, nested: { count: 1 } });
    expect(JSON.stringify(body)).not.toContain("customer-marker");
    expect(JSON.stringify(body)).not.toContain("event-private-marker");
    expect(JSON.stringify(body)).not.toContain("provider-private-marker");
  });
});
