import { describe, expect, it } from "vitest";
import {
  createInMemoryReplayStore,
  createInMemoryRouterDeps,
  processReplayBatch,
  type ReplayRow,
} from "../src/index.ts";
import { replayEventId } from "../src/replay.ts";

const NOW = new Date("2026-05-15T10:00:00Z");

function row(overrides: Partial<ReplayRow> = {}): ReplayRow {
  return {
    id: "rpy_1",
    workspace_id: "ws_1",
    event_id: "evt_1",
    source_id: "src_1",
    r2_key: "events/ws_1/2026-05-15/evt_1",
    scope: "route",
    route_id: null,
    destination_id: null,
    reason: "operator-initiated",
    replay_job_id: null,
    ...overrides,
  };
}

describe("processReplayBatch", () => {
  it("returns empty when no pending rows", async () => {
    const router = createInMemoryRouterDeps({ now: () => NOW });
    const replays = createInMemoryReplayStore([]);
    const summaries = await processReplayBatch({ router, replays });
    expect(summaries).toEqual([]);
  });

  it("re-runs the routing pipeline for each pending replay row", async () => {
    const router = createInMemoryRouterDeps({
      now: () => NOW,
      payloads: { "events/ws_1/2026-05-15/evt_1": JSON.stringify({ type: "ping" }) },
      routes: [
        {
          route_id: "rt_a",
          workspace_id: "ws_1",
          source_id: "src_1",
          status: "active",
          destination_ids: ["dst_x"],
        },
      ],
    });
    const replays = createInMemoryReplayStore([row()]);

    const summaries = await processReplayBatch({ router, replays });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.replay_id).toBe("rpy_1");
    expect(summaries[0]?.matched_routes).toBe(1);
    expect(summaries[0]?.enqueued_deliveries).toBe(1);
    expect(router.deliveryRecords).toHaveLength(1);
    expect(replays.dispatched.has("rpy_1")).toBe(true);
    expect(replays.done.has("rpy_1")).toBe(false);
    expect(replays.failed.size).toBe(0);
  });

  it("marks the replay failed and continues when the replay produces no delivery attempts", async () => {
    const router = createInMemoryRouterDeps({
      now: () => NOW,
      payloads: {}, // no payload — but processQueueMessage handles missing
      routes: [],
    });
    const replays = createInMemoryReplayStore([row({ id: "rpy_missing" })]);

    const summaries = await processReplayBatch({ router, replays });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.matched_routes).toBe(0);
    expect(replays.dispatched.has("rpy_missing")).toBe(false);
    expect(replays.failed.get("rpy_missing")).toBe("Replay produced no delivery attempts.");
  });

  it("scope='route' with a specific route_id targets ONLY that route (no fan-out)", async () => {
    const twoRoutes = {
      now: () => NOW,
      payloads: { "events/ws_1/2026-05-15/evt_1": JSON.stringify({ type: "ping" }) },
      routes: [
        { route_id: "rt_a", workspace_id: "ws_1", source_id: "src_1", status: "active" as const, destination_ids: ["dst_x"] },
        { route_id: "rt_b", workspace_id: "ws_1", source_id: "src_1", status: "active" as const, destination_ids: ["dst_y"] },
      ],
    };

    // Specific route_id → exactly that route, NOT both.
    const scoped = await processReplayBatch({
      router: createInMemoryRouterDeps(twoRoutes),
      replays: createInMemoryReplayStore([row({ scope: "route", route_id: "rt_a" })]),
    });
    expect(scoped[0]?.matched_routes).toBe(1);

    // Null route_id (route-level dead letter) → re-route through ALL routes.
    const reroute = await processReplayBatch({
      router: createInMemoryRouterDeps(twoRoutes),
      replays: createInMemoryReplayStore([row({ scope: "route", route_id: null })]),
    });
    expect(reroute[0]?.matched_routes).toBe(2);
  });

  it("respects batchSize and leaves remaining rows pending", async () => {
    const router = createInMemoryRouterDeps({
      now: () => NOW,
      payloads: {
        "k0": "{}",
        "k1": "{}",
        "k2": "{}",
      },
      routes: [],
    });
    const replays = createInMemoryReplayStore([
      row({ id: "a", r2_key: "k0" }),
      row({ id: "b", r2_key: "k1" }),
      row({ id: "c", r2_key: "k2" }),
    ]);

    const summaries = await processReplayBatch({ router, replays, batchSize: 2 });
    expect(summaries.map((s) => s.replay_id)).toEqual(["a", "b"]);
    expect(replays.pending).toHaveLength(1);
    expect(replays.pending[0]?.id).toBe("c");
  });

  it("synthesises a replay-tagged event_id so delivery idempotency keys differ from the original", async () => {
    const router = createInMemoryRouterDeps({
      now: () => NOW,
      payloads: { "events/ws_1/2026-05-15/evt_1": JSON.stringify({ type: "ping" }) },
      routes: [
        {
          route_id: "rt_a",
          workspace_id: "ws_1",
          source_id: "src_1",
          status: "active",
          destination_ids: ["dst_x"],
        },
      ],
    });
    const replays = createInMemoryReplayStore([row({ id: "rpy_abc", event_id: "evt_orig" })]);

    await processReplayBatch({ router, replays });

    expect(router.deliveryRecords).toHaveLength(1);
    const sent = router.deliveryRecords[0]!;
    // Replay-tagged event_id flows into the destination message.
    expect(sent.event_id).toBe("evt_orig#rpy_abc");
    // Idempotency key differs from what the original delivery would have had.
    expect(sent.idempotency_key).toBe("ws_1:evt_orig#rpy_abc:rt_a:dst_x");
    expect(sent.idempotency_key).not.toBe("ws_1:evt_orig:rt_a:dst_x");
  });

  it("replayEventId helper is deterministic and pure", () => {
    expect(replayEventId("evt_1", "rpy_a")).toBe("evt_1#rpy_a");
    expect(replayEventId("evt_1", "rpy_a")).toBe(replayEventId("evt_1", "rpy_a"));
  });

  it("uses payload hints when supplied", async () => {
    const router = createInMemoryRouterDeps({
      now: () => NOW,
      payloads: { "k0": "{}" },
      routes: [],
    });
    const replays = createInMemoryReplayStore([row({ id: "h", r2_key: "k0" })]);

    let hintsResolved = false;
    const summaries = await processReplayBatch({
      router,
      replays,
      hints: {
        async resolveHints(eventId, key) {
          hintsResolved = true;
          expect(eventId).toBe("evt_1");
          expect(key).toBe("k0");
          return { content_type: "application/x-www-form-urlencoded" };
        },
      },
    });

    expect(hintsResolved).toBe(true);
    expect(summaries).toHaveLength(1);
  });
});
