import { describe, expect, it } from "vitest";
import {
  createHttpConnector,
  createR2Connector,
  createUnsupportedConnector,
  type FetchLike,
  type ObjectStoreLike,
} from "../src/index.js";
import type { Destination } from "@axel/shared";

describe("connectors", () => {
  it("delivers HTTP payloads through the injected fetch implementation", async () => {
    const calls: Array<{ url: string; body: ArrayBuffer }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return {
        status: 204,
        async text() {
          return "";
        },
      };
    };

    const connector = createHttpConnector(fetchImpl);
    const attempt = await connector.deliver(
      toArrayBuffer(new TextEncoder().encode(JSON.stringify({ ok: true }))),
      destination("http", { url: "https://example.test/webhook" }),
      { eventId: "evt-1" },
    );

    expect(attempt.status).toBe("success");
    expect(attempt.event_id).toBe("evt-1");
    expect(calls[0]?.url).toBe("https://example.test/webhook");
  });

  it("stores R2 payloads using a generated object key", async () => {
    const writes: Array<{ key: string; metadata: Record<string, string> }> = [];
    const store: ObjectStoreLike = {
      async put(key, _value, metadata) {
        writes.push({ key, metadata });
      },
    };

    const connector = createR2Connector(store);
    const attempt = await connector.deliver(
      toArrayBuffer(new TextEncoder().encode("{}")),
      destination("r2", { bucket: "events", keyPrefix: "archive" }),
      { eventId: "evt-2" },
    );

    expect(attempt.status).toBe("success");
    expect(attempt.event_id).toBe("evt-2");
    expect(writes[0]?.key).toMatch(/^archive\/ws-1\//);
    expect(writes[0]?.metadata.destination_id).toBe("dest-1");
  });

  it("surfaces a 429 Retry-After (delta seconds) on the attempt response (AXE-28)", async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 429,
      async text() {
        return "rate limited";
      },
      headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "30" : null) },
    });
    const connector = createHttpConnector(fetchImpl);
    const attempt = await connector.deliver(
      toArrayBuffer(new TextEncoder().encode("{}")),
      destination("http", { url: "https://example.test/webhook" }),
      { eventId: "evt-429" },
    );
    expect(attempt.status).toBe("retry");
    expect(attempt.response).toMatchObject({ status: 429, retry_after_seconds: 30 });
  });

  it("passes a context timeoutMs through to an AbortSignal on the fetch call (AXE-28)", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      receivedSignal = init.signal;
      return { status: 204, async text() { return ""; } };
    };
    const connector = createHttpConnector(fetchImpl);
    await connector.deliver(
      toArrayBuffer(new TextEncoder().encode("{}")),
      destination("http", { url: "https://example.test/webhook" }),
      { eventId: "evt-timeout", timeoutMs: 500 },
    );
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("marks unsupported connector types as terminal", async () => {
    const connector = createUnsupportedConnector("postgres");
    const attempt = await connector.deliver(
      new ArrayBuffer(0),
      destination("postgres", {}),
      { eventId: "evt-3" },
    );

    expect(attempt.status).toBe("dead");
    expect(attempt.response).toEqual({
      error: "postgres connector is not configured in this runtime",
    });
  });
});

function destination<TConfig>(type: Destination["type"], config: TConfig): Destination<TConfig> {
  return {
    destination_id: "dest-1",
    workspace_id: "ws-1",
    type,
    config,
    credentials_ref: "cred-1",
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
