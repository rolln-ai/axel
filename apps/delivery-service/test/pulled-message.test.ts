import { describe, expect, it } from "vitest";
import type { DestinationQueueMessage } from "@axel/shared";
import { parsePulledMessageBody } from "../src/pulled-message.ts";

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

  it("rejects malformed base64, non-object JSON, and unsupported content types", () => {
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
        body: "opaque",
        metadata: { "CF-Content-Type": "v8" },
      }),
    ).toBeNull();
  });
});
