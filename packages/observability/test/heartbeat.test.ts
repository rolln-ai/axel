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
});
