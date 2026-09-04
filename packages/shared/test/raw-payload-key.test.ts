import { describe, expect, it } from "vitest";
import {
  isCanonicalRawPayloadKey,
  parseCanonicalRawPayloadKey,
} from "../src/raw-payload-key.js";

describe("canonical raw payload keys", () => {
  it.each([
    ["events/ws_alpha/provider/evt_provider", "event"],
    ["events/ws_alpha/2026-08-27/evt_dated", "event"],
    ["pull/ws_alpha/src_alpha/customers/evt_pull.json", "pull"],
  ] as const)("accepts generated key %s", (key, kind) => {
    expect(parseCanonicalRawPayloadKey(key)).toMatchObject({ kind });
  });

  it.each([
    "",
    "/events/ws_alpha/2026-08-27/evt_1",
    "events//2026-08-27/evt_1",
    "events/ws_alpha//evt_1",
    "events/ws_alpha/./evt_1",
    "events/ws_alpha/../evt_1",
    "events/ws_alpha/2026-02-30/evt_1",
    "events/ws_alpha/2026-08-27/evt_1/extra",
    "events/ws_alpha/not-a-date/evt_1",
    "events/ws_alpha/2026-08-27/evt_1\nshadow",
    "pull/ws_alpha/src_alpha/customers/.json",
    "pull/ws_alpha/src_alpha/customers/evt_1",
    "pull/ws_alpha/src_alpha/customers/evt_1.json/extra",
  ])("rejects non-canonical key without normalizing it: %s", (key) => {
    expect(parseCanonicalRawPayloadKey(key)).toBeNull();
  });

  it("binds workspace and event exactly", () => {
    const key = "events/ws_victim/2026-08-27/evt_victim";
    expect(isCanonicalRawPayloadKey(key, {
      workspaceId: "ws_attacker",
      eventId: "evt_victim",
    })).toBe(false);
    expect(isCanonicalRawPayloadKey(key, {
      workspaceId: "ws_victim",
      eventId: "evt_other",
    })).toBe(false);
    expect(isCanonicalRawPayloadKey(key, {
      workspaceId: "ws_victim",
      eventId: "evt_victim",
    })).toBe(true);
  });

  it("binds pull source and strips only the final .json suffix for event comparison", () => {
    const key = "pull/ws_alpha/src_alpha/customers/evt_pull.json";
    expect(isCanonicalRawPayloadKey(key, {
      workspaceId: "ws_alpha",
      sourceId: "src_other",
      eventId: "evt_pull",
    })).toBe(false);
    expect(isCanonicalRawPayloadKey(key, {
      workspaceId: "ws_alpha",
      sourceId: "src_alpha",
      eventId: "evt_pull.json",
    })).toBe(false);
    expect(isCanonicalRawPayloadKey(key, {
      workspaceId: "ws_alpha",
      sourceId: "src_alpha",
      eventId: "evt_pull",
    })).toBe(true);
  });
});
