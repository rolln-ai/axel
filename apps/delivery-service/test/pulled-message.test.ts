import { describe, expect, it } from "vitest";
import type { DestinationQueueMessage } from "@axel/shared";
import {
  parsePulledMessageBody,
  type PulledMessage,
} from "../src/pulled-message.ts";

const MESSAGE: DestinationQueueMessage = {
  event_id: "evt_1",
  workspace_id: "ws_1",
  source_id: "src_1",
  route_id: "route_1",
  destination_id: "dest_1",
  r2_key: "events/ws_1/evt_1.json",
  received_at: "2026-08-26T12:00:00.000Z",
  enqueued_at: "2026-08-26T12:00:01.000Z",
  attempt_no: 1,
  max_attempts: 5,
  idempotency_key: "idem_1",
  content_type: "application/json",
  size_bytes: 17,
  payload: { private: "value" },
  headers: { "content-type": "application/json" },
  query: {},
  is_test: false,
};

function encode(message: DestinationQueueMessage): string {
  return Buffer.from(JSON.stringify(message), "utf8").toString("base64");
}

describe("parsePulledMessageBody", () => {
  it("decodes the base64 JSON format returned by Cloudflare HTTP Pull", () => {
    expect(
      parsePulledMessageBody({
        body: encode(MESSAGE),
        metadata: { "CF-Content-Type": "json" },
      }),
    ).toEqual(MESSAGE);
  });

  it("parses the plain JSON string observed in Cloudflare HTTP Pull responses", () => {
    const productionResponse: PulledMessage = {
      body: JSON.stringify(MESSAGE),
      lease_id: "lease_1",
      id: "message_1",
      metadata: {
        CF_QUEUE_NAME: "axel-delivery-native",
        "CF-Content-Type": "json",
      },
    };

    expect(parsePulledMessageBody(productionResponse)).toEqual(MESSAGE);
  });

  it("decodes a bytes message containing Axel JSON", () => {
    expect(
      parsePulledMessageBody({
        body: encode(MESSAGE),
        metadata: { "CF-Content-Type": "bytes" },
      }),
    ).toEqual(MESSAGE);
  });

  it("parses text and legacy unlabelled JSON without base64 decoding", () => {
    const body = JSON.stringify(MESSAGE);
    expect(
      parsePulledMessageBody({ body, metadata: { "CF-Content-Type": "text" } }),
    ).toEqual(MESSAGE);
    expect(parsePulledMessageBody({ body })).toEqual(MESSAGE);
    expect(parsePulledMessageBody({ body: MESSAGE })).toEqual(MESSAGE);
  });

  it("rejects malformed and non-object JSON bodies", () => {
    expect(
      parsePulledMessageBody({
        body: "not base64!",
        metadata: { "CF-Content-Type": "json" },
      }),
    ).toBeNull();
    expect(
      parsePulledMessageBody({
        body: Buffer.from('"not an object"').toString("base64"),
        metadata: { "CF-Content-Type": "json" },
      }),
    ).toBeNull();
    expect(
      parsePulledMessageBody({
        body: "{not json}",
        metadata: { "CF-Content-Type": "json" },
      }),
    ).toBeNull();
    expect(
      parsePulledMessageBody({
        body: JSON.stringify([MESSAGE]),
        metadata: { "CF-Content-Type": "json" },
      }),
    ).toBeNull();
    expect(
      parsePulledMessageBody({
        body: MESSAGE,
        metadata: { "CF-Content-Type": "json" },
      }),
    ).toBeNull();
  });

  it("keeps bytes and v8 bodies fail-closed", () => {
    expect(
      parsePulledMessageBody({
        body: JSON.stringify(MESSAGE),
        metadata: { "CF-Content-Type": "bytes" },
      }),
    ).toBeNull();
    expect(
      parsePulledMessageBody({
        body: "opaque",
        metadata: { "CF-Content-Type": "v8" },
      }),
    ).toBeNull();
  });
});
