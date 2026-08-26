import { describe, expect, it } from "vitest";
import {
  runNudgeScan,
  buildNudge,
  type FailingDestinationRow,
} from "../lib/nudges";
import type { CreateNotificationInput, NotificationRow } from "../lib/notifications";

function dest(over: Partial<FailingDestinationRow> = {}): FailingDestinationRow {
  return {
    id: "d1",
    workspace_id: "ws1",
    name: "My Webhook",
    type: "webhook",
    circuit_state: "open",
    circuit_consecutive_failures: 7,
    ...over,
  };
}

describe("buildNudge", () => {
  it("is an info, workspace-wide nudge keyed per destination, linking to it", () => {
    const n = buildNudge(dest({ id: "d9" }));
    expect(n).toMatchObject({
      kind: "best_practice_destination_failing",
      severity: "info",
      userId: null,
      linkPath: "/destinations/d9/controls",
      dedupKey: "nudge:dest_failing:d9",
    });
  });

  it("describes an open breaker vs a consecutive-failure pile-up", () => {
    expect(buildNudge(dest({ circuit_state: "half_open" })).bodyMd).toContain("half-open");
    expect(
      buildNudge(dest({ circuit_state: "closed", circuit_consecutive_failures: 9 })).bodyMd,
    ).toContain("9 consecutive");
  });

  it("falls back to the type when the destination is unnamed", () => {
    expect(buildNudge(dest({ name: null, type: "postgres" })).title).toContain("postgres destination");
  });
});

describe("runNudgeScan", () => {
  it("emits one nudge per failing destination", async () => {
    const emitted: CreateNotificationInput[] = [];
    const summary = await runNudgeScan({
      listFailingDestinations: async () => [dest({ id: "d1" }), dest({ id: "d2" })],
      emit: async (input) => {
        emitted.push(input);
        return { id: `n${emitted.length}` } as unknown as NotificationRow;
      },
    });
    expect(emitted.map((e) => e.dedupKey)).toEqual([
      "nudge:dest_failing:d1",
      "nudge:dest_failing:d2",
    ]);
    expect(summary.destinations_failing).toBe(2);
    expect(summary.nudges_emitted).toBe(2);
  });

  it("does not count a nudge that the dedup index suppressed (emit → null)", async () => {
    const summary = await runNudgeScan({
      listFailingDestinations: async () => [dest()],
      emit: async () => null,
    });
    expect(summary.destinations_failing).toBe(1);
    expect(summary.nudges_emitted).toBe(0);
  });
});
