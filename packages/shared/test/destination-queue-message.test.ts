import { describe, expect, it } from "vitest";
import { validateDestinationQueueMessage } from "../src/destination-queue-message.js";

describe("destination queue metadata boundary", () => {
  it("accepts rolling legacy maps but erases every value", () => {
    const parsed = validateDestinationQueueMessage({
      queue_message_version: 1,
      event_id: "evt_1",
      workspace_id: "ws_1",
      source_id: "src_1",
      route_id: "rt_1",
      destination_id: "dst_1",
      r2_key: "events/ws_1/2026-08-27/evt_1",
      received_at: "2026-08-27T00:00:00.000Z",
      enqueued_at: "2026-08-27T00:00:01.000Z",
      attempt_no: 1,
      max_attempts: 12,
      idempotency_key: "ws_1:evt_1:rt_1:dst_1",
      content_type: "application/json",
      size_bytes: 2,
      payload: {},
      headers: {
        authorization: "Bearer obvious-secret",
        "x-request-id": "secret-under-innocuous-name",
      },
      query: {
        token: "obvious-query-secret",
        campaign: "secret-under-innocuous-query-name",
      },
      is_test: false,
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message.headers).toEqual({});
      expect(parsed.message.query).toEqual({});
      expect(JSON.stringify(parsed.message)).not.toContain("secret-under");
      expect(JSON.stringify(parsed.message)).not.toContain("obvious-secret");
    }
  });
});
