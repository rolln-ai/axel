import { describe, expect, it } from "vitest";
import { replayEventId } from "@axel/router";
import { replayRequestIdFromEventId } from "../src/replay-event-id.js";

/**
 * Regression cover for a production stall: backfill replays use `rpl_` ids
 * while the parser only matched `rpy_`, so their delivery outcomes were
 * dropped and the rows re-delivered on the 10-minute reclaim forever.
 */
describe("replayRequestIdFromEventId", () => {
  const originalEventId = "019fb964-dbc9-7246-81cf-72c21181137a";

  it("recovers a dashboard replay id (rpy_)", () => {
    const id = "rpy_AbC123-_x";
    expect(replayRequestIdFromEventId(`${originalEventId}#${id}`)).toBe(id);
  });

  it("recovers a backfill replay id (rpl_) — the case that stalled in prod", () => {
    const id = "rpl_ms99lx0a_1_7b7dtc44";
    expect(replayRequestIdFromEventId(`${originalEventId}#${id}`)).toBe(id);
  });

  it("round-trips whatever the router actually produces, for both prefixes", () => {
    // Guards against the tagger and the parser drifting apart again.
    for (const id of ["rpy_AbC123", "rpl_ms99lx0a_1_7b7dtc44"]) {
      const tagged = replayEventId(originalEventId, id);
      expect(replayRequestIdFromEventId(tagged), tagged).toBe(id);
    }
  });

  it("returns null for an ordinary, non-replayed event", () => {
    expect(replayRequestIdFromEventId(originalEventId)).toBeNull();
  });

  it("ignores an unknown prefix rather than inventing an id", () => {
    expect(replayRequestIdFromEventId(`${originalEventId}#xyz_123`)).toBeNull();
    expect(replayRequestIdFromEventId(`${originalEventId}#rpz_123`)).toBeNull();
  });

  it("rejects a marker with no id after it", () => {
    expect(replayRequestIdFromEventId(`${originalEventId}#rpl_`)).toBeNull();
    expect(replayRequestIdFromEventId(`${originalEventId}#rpy_`)).toBeNull();
  });

  it("takes the LAST marker when an id somehow contains one", () => {
    const tagged = `${originalEventId}#rpy_first#rpl_second`;
    expect(replayRequestIdFromEventId(tagged)).toBe("rpl_second");
  });
});
