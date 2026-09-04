import { describe, expect, it, vi } from "vitest";
import type { QueueMessage } from "@axel/shared";
import { processOne, type Env } from "../src/index.ts";

describe("router raw payload key binding", () => {
  it("rejects a foreign-workspace key before route, R2, or delivery access", async () => {
    const r2Get = vi.fn();
    const edgeSend = vi.fn();
    const nativeSend = vi.fn();
    const deadLetterSend = vi.fn();
    const routeFetch = vi.spyOn(globalThis, "fetch");
    const env = {
      EVENTS_RAW: { get: r2Get },
      DELIVERY_QUEUE: { send: edgeSend },
      DELIVERY_NATIVE_QUEUE: { send: nativeSend },
      DEAD_LETTER_QUEUE: { send: deadLetterSend },
      DELIVERY_SERVICE_URL: "https://delivery.example.test",
      DELIVERY_SHARED_SECRET: "test-only-secret",
    } as unknown as Env;
    const message: QueueMessage = {
      event_id: "evt_alpha",
      workspace_id: "ws_alpha",
      source_id: "src_alpha",
      r2_key: "events/ws_victim/2026-08-27/evt_alpha",
      received_at: "2026-08-27T00:00:00.000Z",
      content_type: "application/json",
      size_bytes: 2,
      shard: 0,
      headers: {},
      query: {},
    };

    await expect(processOne(message, env)).rejects.toThrow(
      "raw_payload_key_mismatch",
    );

    expect(routeFetch).not.toHaveBeenCalled();
    expect(r2Get).not.toHaveBeenCalled();
    expect(edgeSend).not.toHaveBeenCalled();
    expect(nativeSend).not.toHaveBeenCalled();
    expect(deadLetterSend).not.toHaveBeenCalled();
  });
});
