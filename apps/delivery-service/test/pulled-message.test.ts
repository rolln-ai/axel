import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DestinationQueueMessage } from "@axel/shared";
import {
  parsePulledMessage,
  parsePulledBatchResponse,
  parsePulledMessageBody,
  type PulledMessage,
  validateDestinationQueueMessage,
} from "../src/pulled-message.ts";

const MESSAGE: DestinationQueueMessage = {
  queue_message_version: 1,
  event_id: "evt_contract_1",
  workspace_id: "ws_contract",
  source_id: "src_contract",
  route_id: "route_contract",
  destination_id: "dest_contract",
  r2_key: "events/ws_contract/evt_contract_1.json",
  received_at: "2026-08-26T12:00:00.000Z",
  enqueued_at: "2026-08-26T12:00:01.000Z",
  attempt_no: 1,
  max_attempts: 12,
  idempotency_key: "ws_contract:evt_contract_1:route_contract:dest_contract",
  content_type: "application/json",
  size_bytes: 17,
  payload: { canary: true },
  headers: { "content-type": "application/json" },
  query: {},
  is_test: true,
};

function fixture(name: "plain" | "base64"): PulledMessage {
  const path = new URL(`./fixtures/cloudflare-http-pull-${name}.json`, import.meta.url);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    result: { messages: PulledMessage[] };
  };
  return parsed.result.messages[0]!;
}

function encode(message: unknown): string {
  return Buffer.from(JSON.stringify(message), "utf8").toString("base64");
}

describe("parsePulledMessage", () => {
  it("accepts the captured base64 Cloudflare HTTP Pull shape", () => {
    expect(parsePulledMessageBody(fixture("base64"))).toEqual(MESSAGE);
  });

  it("accepts the plain JSON string observed in production", () => {
    expect(parsePulledMessageBody(fixture("plain"))).toEqual(MESSAGE);
  });

  it("normalizes an unversioned queued message during a rolling deploy", () => {
    const { queue_message_version: _, ...legacy } = MESSAGE;
    const parsed = parsePulledMessage({
      body: JSON.stringify(legacy),
      metadata: { "CF-Content-Type": "json" },
    });

    expect(parsed).toEqual({ ok: true, message: MESSAGE, wireVersion: 0 });
  });

  it("rejects an unknown future contract version", () => {
    const parsed = parsePulledMessage({
      body: JSON.stringify({ ...MESSAGE, queue_message_version: 2 }),
      metadata: { "CF-Content-Type": "json" },
    });

    expect(parsed).toEqual({ ok: false, code: "unsupported_version" });
  });

  it("decodes bytes and legacy text only through the same validator", () => {
    expect(
      parsePulledMessageBody({
        body: encode(MESSAGE),
        metadata: { "CF-Content-Type": "bytes" },
      }),
    ).toEqual(MESSAGE);
    expect(
      parsePulledMessageBody({
        body: JSON.stringify(MESSAGE),
        metadata: { "CF-Content-Type": "text" },
      }),
    ).toEqual(MESSAGE);
    expect(parsePulledMessageBody({ body: MESSAGE })).toEqual(MESSAGE);
  });

  it("keeps malformed encodings and unsupported v8 messages fail-closed", () => {
    expect(
      parsePulledMessage({
        body: "not base64!",
        metadata: { "CF-Content-Type": "bytes" },
      }),
    ).toEqual({ ok: false, code: "invalid_base64" });
    expect(
      parsePulledMessage({
        body: "opaque",
        metadata: { "CF-Content-Type": "v8" },
      }),
    ).toEqual({ ok: false, code: "unsupported_content_type" });
    expect(
      parsePulledMessage({
        body: Buffer.from('"not an object"').toString("base64"),
        metadata: { "CF-Content-Type": "json" },
      }),
    ).toEqual({ ok: false, code: "body_not_object" });
  });
});

describe("parsePulledBatchResponse", () => {
  it("validates captured Cloudflare envelopes before their leases are used", () => {
    const source = JSON.parse(
      readFileSync(new URL("./fixtures/cloudflare-http-pull-plain.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(parsePulledBatchResponse(source)).toEqual([fixture("plain")]);
  });

  it("accepts Cloudflare's schema-permitted attempt and opaque metadata variants", () => {
    const body = JSON.stringify(MESSAGE);
    const parsed = parsePulledBatchResponse({
      result: {
        messages: [
          {
            id: "message-zero-attempt",
            lease_id: "lease-zero-attempt",
            attempts: 0,
            timestamp_ms: 0,
            body,
            metadata: null,
          },
          {
            id: "message-opaque-metadata",
            lease_id: "lease-opaque-metadata",
            body,
            metadata: "provider-owned-metadata",
          },
        ],
      },
    });

    expect(parsed).toEqual([
      {
        id: "message-zero-attempt",
        lease_id: "lease-zero-attempt",
        attempts: 0,
        timestamp_ms: 0,
        body,
      },
      {
        id: "message-opaque-metadata",
        lease_id: "lease-opaque-metadata",
        body,
      },
    ]);
    expect(parsed.map(parsePulledMessage)).toEqual([
      { ok: true, message: MESSAGE, wireVersion: 1 },
      { ok: true, message: MESSAGE, wireVersion: 1 },
    ]);
  });

  it.each([
    null,
    { success: false, errors: [{ message: "credential must never reach logs" }] },
    { errors: [{ message: "payload must never reach logs" }], result: { messages: [] } },
    { result: { messages: "not-an-array" } },
    { result: { messages: [{ id: "message", body: "{}" }] } },
    { result: { messages: [{ lease_id: "lease", body: "{}" }] } },
    { result: { messages: [{ id: "message", lease_id: "lease" }] } },
    { result: { messages: [{ id: "message", lease_id: "lease", attempts: -1, body: "{}" }] } },
    { result: { messages: [{ id: "message", lease_id: "lease", attempts: 1.5, body: "{}" }] } },
  ])("rejects an invalid pull response without exposing its body", (candidate) => {
    expect(() => parsePulledBatchResponse(candidate)).toThrow("cloudflare_pull_response_contract_invalid");
  });
});

describe("validateDestinationQueueMessage", () => {
  const requiredFields: Array<keyof DestinationQueueMessage> = [
    "event_id",
    "workspace_id",
    "source_id",
    "route_id",
    "destination_id",
    "r2_key",
    "received_at",
    "enqueued_at",
    "attempt_no",
    "max_attempts",
    "idempotency_key",
    "content_type",
    "size_bytes",
    "payload",
    "headers",
    "query",
    "is_test",
  ];

  it.each(requiredFields)("rejects a message missing %s", (field) => {
    const candidate = { ...MESSAGE } as Record<string, unknown>;
    delete candidate[field];
    const parsed = validateDestinationQueueMessage(candidate);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.field).toBe(field);
  });

  it.each([
    ["attempt_no", 0],
    ["attempt_no", 13],
    ["max_attempts", 0],
    ["size_bytes", -1],
    ["headers", { authorization: 123 }],
    ["query", []],
    ["received_at", "not-a-date"],
    ["binding", "not-an-object"],
  ] as const)("rejects invalid %s without returning the value", (field, value) => {
    const parsed = validateDestinationQueueMessage({ ...MESSAGE, [field]: value });

    expect(parsed).toEqual({ ok: false, code: "invalid_field", field });
    expect(Object.keys(parsed).sort()).toEqual(["code", "field", "ok"]);
  });

  it("strips unknown top-level fields before delivery", () => {
    const parsed = validateDestinationQueueMessage({
      ...MESSAGE,
      unexpected_secret: "must-not-reach-a-connector",
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message).not.toHaveProperty("unexpected_secret");
  });
});
