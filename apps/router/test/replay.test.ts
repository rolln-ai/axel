import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryReplayStore,
  createInMemoryRouterDeps,
  processReplayBatch,
  replayPayloadKeyBelongsToWorkspace,
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
        "events/ws_1/2026-05-15/evt_a": "{}",
        "events/ws_1/2026-05-15/evt_b": "{}",
        "events/ws_1/2026-05-15/evt_c": "{}",
      },
      routes: [],
    });
    const replays = createInMemoryReplayStore([
      row({ id: "rpy_a", event_id: "evt_a", r2_key: "events/ws_1/2026-05-15/evt_a" }),
      row({ id: "rpy_b", event_id: "evt_b", r2_key: "events/ws_1/2026-05-15/evt_b" }),
      row({ id: "rpy_c", event_id: "evt_c", r2_key: "events/ws_1/2026-05-15/evt_c" }),
    ]);

    const summaries = await processReplayBatch({ router, replays, batchSize: 2 });
    expect(summaries.map((s) => s.replay_id)).toEqual(["rpy_a", "rpy_b"]);
    expect(replays.pending).toHaveLength(1);
    expect(replays.pending[0]?.id).toBe("rpy_c");
  });

  it("synthesises a replay-tagged event_id so delivery idempotency keys differ from the original", async () => {
    const router = createInMemoryRouterDeps({
      now: () => NOW,
      payloads: { "events/ws_1/2026-05-15/evt_orig": JSON.stringify({ type: "ping" }) },
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
    const replays = createInMemoryReplayStore([row({
      id: "rpy_abc",
      event_id: "evt_orig",
      r2_key: "events/ws_1/2026-05-15/evt_orig",
    })]);

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
      payloads: { "events/ws_1/2026-05-15/evt_1": "{}" },
      routes: [{
        route_id: "rt_hints",
        workspace_id: "ws_1",
        source_id: "src_1",
        status: "active",
        destination_ids: ["dst_hints"],
      }],
    });
    const replays = createInMemoryReplayStore([
      row({ id: "rpy_h" }),
    ]);

    let hintsResolved = false;
    const summaries = await processReplayBatch({
      router,
      replays,
      hints: {
        async resolveHints(eventId, key, workspaceId, sourceId) {
          hintsResolved = true;
          expect(eventId).toBe("evt_1");
          expect(key).toBe("events/ws_1/2026-05-15/evt_1");
          expect(workspaceId).toBe("ws_1");
          expect(sourceId).toBe("src_1");
          return {
            content_type: "application/x-www-form-urlencoded",
            headers: { "x-customer-ref": "historical-secret" },
            query: { campaign: "historical-query-secret" },
          };
        },
      },
    });

    expect(hintsResolved).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(router.deliveryRecords[0]!.headers).toEqual({});
    expect(router.deliveryRecords[0]!.query).toEqual({});
  });

  it("rejects a foreign-workspace raw key before hints or R2 are touched", async () => {
    let hintsResolved = false;
    const router = createInMemoryRouterDeps({
      now: () => NOW,
      payloads: { "events/ws_victim/2026-05-15/evt_1": "customer secret" },
      routes: [
        {
          route_id: "rt_attacker",
          workspace_id: "ws_1",
          source_id: "src_1",
          status: "active",
          destination_ids: ["dst_attacker"],
        },
      ],
    });
    const r2Get = vi.fn(async () => null);
    router.rawPayloads = { get: r2Get };
    const replays = createInMemoryReplayStore([
      row({ id: "rpy_foreign", r2_key: "events/ws_victim/2026-05-15/evt_1" }),
    ]);

    const summaries = await processReplayBatch({
      router,
      replays,
      hints: {
        async resolveHints() {
          hintsResolved = true;
          return null;
        },
      },
    });

    expect(summaries).toEqual([]);
    expect(hintsResolved).toBe(false);
    expect(r2Get).not.toHaveBeenCalled();
    expect(router.deliveryRecords).toEqual([]);
    expect(replays.failed.get("rpy_foreign")).toBe("replay_payload_key_mismatch");
  });

  it("requires a canonical key and exact workspace, event, and pull source", () => {
    expect(replayPayloadKeyBelongsToWorkspace(
      "events/ws_1/2026-05-15/evt_1",
      "ws_1",
      "evt_1",
      "src_1",
    )).toBe(true);
    expect(replayPayloadKeyBelongsToWorkspace(
      "pull/ws_1/src_1/customers/evt_1.json",
      "ws_1",
      "evt_1",
      "src_1",
    )).toBe(true);
    expect(replayPayloadKeyBelongsToWorkspace(
      "events/ws_10/2026-05-15/evt_1",
      "ws_1",
      "evt_1",
      "src_1",
    )).toBe(false);
    expect(replayPayloadKeyBelongsToWorkspace(
      "events/ws_1/../ws_victim/event",
      "ws_1",
      "event",
      "src_1",
    )).toBe(false);
    expect(replayPayloadKeyBelongsToWorkspace(
      "queue-spill/ws_1/event",
      "ws_1",
      "event",
      "src_1",
    )).toBe(false);
  });
});
