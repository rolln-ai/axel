import { describe, expect, it } from "vitest";
import {
  QUEUE_MESSAGE_SPILL_THRESHOLD_BYTES,
  QUEUE_SPILL_KEY_PREFIX,
  QueueSpillBodyCorruptError,
  QueueSpillKeyMismatchError,
  QueueSpillObjectMissingError,
  buildSpillKey,
  deleteSpillIfPresent,
  hasCanonicalSpillKey,
  hydrateIfSpilled,
  isQueueSpillBodyCorruptError,
  isQueueSpillObjectMissingError,
  spillIfOversized,
  type DestinationQueueMessage,
  type QueueSpillReader,
  type QueueSpillWriter,
} from "@axel/shared";

function baseMessage(overrides: Partial<DestinationQueueMessage> = {}): DestinationQueueMessage {
  return {
    queue_message_version: 1,
    event_id: "evt-1",
    workspace_id: "ws-1",
    source_id: "src-1",
    route_id: "rt-1",
    destination_id: "dst-1",
    r2_key: "events/ws-1/evt-1",
    received_at: "2026-05-27T12:00:00.000Z",
    enqueued_at: "2026-05-27T12:00:01.000Z",
    attempt_no: 1,
    max_attempts: 12,
    idempotency_key: "evt-1:rt-1:dst-1",
    content_type: "application/json",
    size_bytes: 12,
    payload: { type: "small" },
    headers: { "content-type": "application/json" },
    query: {},
    is_test: false,
    binding: null,
    ...overrides,
  };
}

function fakeWriter(): QueueSpillWriter & { calls: Array<{ key: string; body: string }> } {
  const calls: Array<{ key: string; body: string }> = [];
  return {
    calls,
    async put(key: string, body: string): Promise<void> {
      calls.push({ key, body });
    },
  };
}

function fakeReader(
  store: Record<string, string> = {},
): QueueSpillReader & {
  reads: string[];
  deletes: string[];
} {
  const reads: string[] = [];
  const deletes: string[] = [];
  return {
    reads,
    deletes,
    async get(key: string): Promise<ArrayBuffer | null> {
      reads.push(key);
      const v = store[key];
      if (v === undefined) return null;
      return new TextEncoder().encode(v).buffer;
    },
    async delete(key: string): Promise<void> {
      deletes.push(key);
      delete store[key];
    },
  };
}

describe("queue-spill (producer)", () => {
  it("passes a small message through without spilling", async () => {
    const writer = fakeWriter();
    const msg = baseMessage();
    const out = await spillIfOversized(msg, writer);
    expect(out).toBe(msg);
    expect(writer.calls).toHaveLength(0);
  });

  it("spills when the message exceeds the threshold", async () => {
    const writer = fakeWriter();
    const huge = "x".repeat(QUEUE_MESSAGE_SPILL_THRESHOLD_BYTES + 1024);
    const msg = baseMessage({ payload: { blob: huge } });

    const out = await spillIfOversized(msg, writer);

    expect(writer.calls).toHaveLength(1);
    const key = writer.calls[0]!.key;
    expect(key.startsWith(`${QUEUE_SPILL_KEY_PREFIX}/`)).toBe(true);
    expect(out.spill_r2_key).toBe(key);
    expect(out.payload).toBeNull();
    expect(out.headers).toEqual({});
    expect(out.query).toEqual({});
    // Metadata is preserved on the wire form.
    expect(out.event_id).toBe(msg.event_id);
    expect(out.destination_id).toBe(msg.destination_id);
    expect(out.idempotency_key).toBe(msg.idempotency_key);
  });

  it("writes payload + headers + query to the spill object", async () => {
    const writer = fakeWriter();
    const huge = "x".repeat(QUEUE_MESSAGE_SPILL_THRESHOLD_BYTES + 1024);
    const msg = baseMessage({
      payload: { blob: huge },
      headers: { "x-large": "yes" },
      query: { q: "search" },
    });
    await spillIfOversized(msg, writer);
    const parsed = JSON.parse(writer.calls[0]!.body) as {
      payload: { blob: string };
      headers: Record<string, string>;
      query: Record<string, string>;
    };
    expect(parsed.payload.blob).toBe(huge);
    expect(parsed.headers).toEqual({ "x-large": "yes" });
    expect(parsed.query).toEqual({ q: "search" });
  });

  it("uses per-attempt spill keys so replays don't collide", () => {
    const a1 = buildSpillKey(baseMessage({ attempt_no: 1 }));
    const a2 = buildSpillKey(baseMessage({ attempt_no: 2 }));
    expect(a1).not.toBe(a2);
    expect(a1).toContain("/1.json");
    expect(a2).toContain("/2.json");
  });

  it("strips inline fields without re-spilling when spill_r2_key is already set", async () => {
    const writer = fakeWriter();
    const msg = baseMessage({
      spill_r2_key: "queue-spill/ws-1/evt-1/dst-1/1.json",
      payload: { hydrated: true },
      headers: { "x-anything": "1" },
      query: { q: "x" },
    });
    const out = await spillIfOversized(msg, writer);
    expect(writer.calls).toHaveLength(0);
    expect(out.spill_r2_key).toBe("queue-spill/ws-1/evt-1/dst-1/1.json");
    expect(out.payload).toBeNull();
    expect(out.headers).toEqual({});
    expect(out.query).toEqual({});
  });

  it("re-spills a hydrated retry under the incremented attempt's canonical key", async () => {
    const writer = fakeWriter();
    const msg = baseMessage({
      attempt_no: 2,
      spill_r2_key: "queue-spill/ws-1/evt-1/dst-1/1.json",
      payload: { hydrated: true },
      headers: { "x-retry": "yes" },
      query: { retry: "2" },
    });

    const out = await spillIfOversized(msg, writer);

    expect(writer.calls).toEqual([{
      key: "queue-spill/ws-1/evt-1/dst-1/2.json",
      body: JSON.stringify({
        payload: { hydrated: true },
        headers: { "x-retry": "yes" },
        query: { retry: "2" },
      }),
    }]);
    expect(out.spill_r2_key).toBe("queue-spill/ws-1/evt-1/dst-1/2.json");
    expect(out.payload).toBeNull();
    expect(hasCanonicalSpillKey(out)).toBe(true);
  });
});

describe("queue-spill (consumer)", () => {
  it("returns the message unchanged when there is no spill key", async () => {
    const reader = fakeReader();
    const msg = baseMessage();
    const out = await hydrateIfSpilled(msg, reader);
    expect(out).toBe(msg);
    expect(reader.reads).toHaveLength(0);
  });

  it("hydrates payload/headers/query from R2 when spill_r2_key is set", async () => {
    const key = "queue-spill/ws-1/evt-1/dst-1/1.json";
    const reader = fakeReader({
      [key]: JSON.stringify({
        payload: { full: "data" },
        headers: { "x-rebuilt": "yes" },
        query: { q: "v" },
      }),
    });
    const stripped = baseMessage({
      spill_r2_key: key,
      payload: null,
      headers: {},
      query: {},
    });
    const out = await hydrateIfSpilled(stripped, reader);
    expect(out.payload).toEqual({ full: "data" });
    expect(out.headers).toEqual({ "x-rebuilt": "yes" });
    expect(out.query).toEqual({ q: "v" });
    expect(out.spill_r2_key).toBe(key);
    expect(reader.reads).toEqual([key]);
  });

  it.each([
    ["workspace", "queue-spill/ws-other/evt-1/dst-1/1.json"],
    ["event", "queue-spill/ws-1/evt-other/dst-1/1.json"],
    ["destination", "queue-spill/ws-1/evt-1/dst-other/1.json"],
  ])("rejects a cross-%s spill key before reading R2", async (_dimension, spillKey) => {
    const reader = fakeReader({
      [spillKey]: JSON.stringify({ payload: { secret: true }, headers: {}, query: {} }),
    });
    const msg = baseMessage({ spill_r2_key: spillKey, payload: null, headers: {}, query: {} });

    const err = await hydrateIfSpilled(msg, reader).catch((cause: unknown) => cause);

    expect(err).toBeInstanceOf(QueueSpillKeyMismatchError);
    expect(reader.reads).toEqual([]);
  });

  it("throws spill_r2_key_missing when the R2 object is gone", async () => {
    const reader = fakeReader();
    const msg = baseMessage({ spill_r2_key: "queue-spill/ws-1/evt-1/dst-1/1.json" });
    await expect(hydrateIfSpilled(msg, reader)).rejects.toThrow(QueueSpillObjectMissingError);
    await expect(hydrateIfSpilled(msg, reader)).rejects.toThrow(/spill_r2_key_missing/);
  });

  it("identifies missing spill object errors by class or legacy message", () => {
    expect(isQueueSpillObjectMissingError(new QueueSpillObjectMissingError("queue-spill/a/b/c/1.json"))).toBe(true);
    expect(isQueueSpillObjectMissingError(new Error("spill_r2_key_missing: queue-spill/a/b/c/1.json"))).toBe(true);
    expect(isQueueSpillObjectMissingError(new Error("r2_get_500"))).toBe(false);
  });

  // JAVASCRIPT-3M: a truncated body reached JSON.parse and surfaced as
  // "SyntaxError: Unterminated string in JSON at position 65536" — a title
  // that fingerprints on the byte offset and names neither the object nor
  // the cause.
  it("throws a keyed error, not a raw SyntaxError, when the spill body is unparseable", async () => {
    const key = "queue-spill/ws-1/evt-1/dst-1/1.json";
    const truncated = `{"payload":{"a":"${"x".repeat(64)}`;
    const reader = fakeReader({ [key]: truncated });
    const msg = baseMessage({ spill_r2_key: key, payload: null, headers: {}, query: {} });

    await expect(hydrateIfSpilled(msg, reader)).rejects.toThrow(QueueSpillBodyCorruptError);
    const err = await hydrateIfSpilled(msg, reader).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueSpillBodyCorruptError);
    const corrupt = err as QueueSpillBodyCorruptError;
    expect(corrupt.spillKey).toBe(key);
    expect(corrupt.byteLength).toBe(truncated.length);
    // The message identifies the object and carries no byte offset.
    expect(corrupt.message).toContain(key);
    expect(corrupt.message).not.toMatch(/position \d+/);
    // The original SyntaxError can quote malformed webhook bytes, so it must
    // not survive on the error object sent to logs or Sentry.
    expect("cause" in corrupt).toBe(false);
  });

  it("identifies corrupt spill body errors by class or message", () => {
    expect(isQueueSpillBodyCorruptError(new QueueSpillBodyCorruptError("k", 10))).toBe(true);
    expect(isQueueSpillBodyCorruptError(new Error("spill_r2_body_corrupt: k (10 bytes)"))).toBe(true);
    expect(isQueueSpillBodyCorruptError(new SyntaxError("Unterminated string in JSON at position 65536"))).toBe(false);
    expect(isQueueSpillBodyCorruptError(new QueueSpillObjectMissingError("k"))).toBe(false);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing payload", { headers: {}, query: {} }],
    ["non-object headers", { payload: {}, headers: [], query: {} }],
    ["non-string header", { payload: {}, headers: { authorization: 42 }, query: {} }],
    ["non-object query", { payload: {}, headers: {}, query: null }],
    ["non-string query", { payload: {}, headers: {}, query: { page: 2 } }],
  ])("rejects a structurally invalid spill body (%s)", async (_case, body) => {
    const key = "queue-spill/ws-1/evt-1/dst-1/1.json";
    const reader = fakeReader({ [key]: JSON.stringify(body) });
    const msg = baseMessage({ spill_r2_key: key, payload: null, headers: {}, query: {} });

    await expect(hydrateIfSpilled(msg, reader)).rejects.toThrow(QueueSpillBodyCorruptError);
    expect(reader.reads).toEqual([key]);
  });

  it("deleteSpillIfPresent skips when there is no key", async () => {
    const reader = fakeReader();
    await deleteSpillIfPresent(baseMessage(), reader);
    expect(reader.deletes).toHaveLength(0);
  });

  it("deleteSpillIfPresent deletes the referenced key", async () => {
    const reader = fakeReader();
    await deleteSpillIfPresent(
      baseMessage({ spill_r2_key: "queue-spill/ws-1/evt-1/dst-1/1.json" }),
      reader,
    );
    expect(reader.deletes).toEqual(["queue-spill/ws-1/evt-1/dst-1/1.json"]);
  });

  it("deleteSpillIfPresent refuses a non-canonical key", async () => {
    const reader = fakeReader();
    await deleteSpillIfPresent(
      baseMessage({ spill_r2_key: "queue-spill/ws-other/evt-1/dst-1/1.json" }),
      reader,
    );
    expect(reader.deletes).toEqual([]);
  });

  it("deleteSpillIfPresent swallows delete errors", async () => {
    const reader: QueueSpillReader = {
      get: async () => null,
      delete: async () => {
        throw new Error("r2 unreachable");
      },
    };
    await expect(
      deleteSpillIfPresent(
        baseMessage({ spill_r2_key: "queue-spill/ws-1/evt-1/dst-1/1.json" }),
        reader,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("queue-spill (round-trip)", () => {
  it("spill → hydrate restores the original payload/headers/query exactly", async () => {
    const writer = fakeWriter();
    const huge = "y".repeat(QUEUE_MESSAGE_SPILL_THRESHOLD_BYTES + 5_000);
    const original = baseMessage({
      payload: { large: huge, nested: { count: 42 } },
      headers: { "x-trace": "abc" },
      query: { q: "needle" },
    });

    const wire = await spillIfOversized(original, writer);
    expect(wire.payload).toBeNull();

    const store: Record<string, string> = {
      [writer.calls[0]!.key]: writer.calls[0]!.body,
    };
    const reader = fakeReader(store);
    const hydrated = await hydrateIfSpilled(wire, reader);

    expect(hydrated.payload).toEqual(original.payload);
    expect(hydrated.headers).toEqual(original.headers);
    expect(hydrated.query).toEqual(original.query);
  });

  it("spill → hydrate → retry spill → hydrate preserves data with canonical keys", async () => {
    const firstWriter = fakeWriter();
    const huge = "z".repeat(QUEUE_MESSAGE_SPILL_THRESHOLD_BYTES + 5_000);
    const original = baseMessage({
      payload: { large: huge },
      headers: { "x-trace": "retry" },
      query: { page: "1" },
    });
    const firstWire = await spillIfOversized(original, firstWriter);
    const firstReader = fakeReader({
      [firstWriter.calls[0]!.key]: firstWriter.calls[0]!.body,
    });
    const firstHydrated = await hydrateIfSpilled(firstWire, firstReader);

    const retryWriter = fakeWriter();
    const retryWire = await spillIfOversized(
      { ...firstHydrated, attempt_no: 2 },
      retryWriter,
    );
    const retryReader = fakeReader({
      [retryWriter.calls[0]!.key]: retryWriter.calls[0]!.body,
    });
    const retryHydrated = await hydrateIfSpilled(retryWire, retryReader);

    expect(retryWire.spill_r2_key).toBe("queue-spill/ws-1/evt-1/dst-1/2.json");
    expect(retryReader.reads).toEqual(["queue-spill/ws-1/evt-1/dst-1/2.json"]);
    expect(retryHydrated.payload).toEqual(original.payload);
    expect(retryHydrated.headers).toEqual(original.headers);
    expect(retryHydrated.query).toEqual(original.query);
  });
});
