import { describe, expect, it } from "vitest";
import {
  countUnreadBillingNotifications,
  countUnreadNotifications,
  emitNotification,
  listUnreadBillingNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  resolveInactiveBillingNotifications,
  type NotificationRow,
} from "../lib/notifications";
import type { Queryable } from "../lib/db";
import { capturingPg } from "@axel/test-utils";

type Captured = { sql: string; params: unknown[] };

function fakeDb(queue: unknown[][]): { db: Queryable; captured: Captured[] } {
  const { query, calls } = capturingPg({ responses: queue.map((rows) => ({ rows })) });
  return { db: { query }, captured: calls };
}

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "notif_1",
    workspace_id: "ws_1",
    user_id: "u1",
    kind: "data_contract_drift",
    severity: "info",
    title: "t",
    body_md: null,
    link_path: null,
    dedup_key: null,
    metadata: {},
    created_at: "t",
    read_at: null,
    alerted_at: null,
    ...over,
  };
}

describe("emitNotification", () => {
  it("inserts a notification and returns the row", async () => {
    const { db, captured } = fakeDb([[row()]]);
    const out = await emitNotification(
      {
        workspaceId: "ws_1",
        userId: "u1",
        kind: "data_contract_drift",
        title: "Drift detected",
        bodyMd: "**details**",
        linkPath: "/data-contracts/em_1",
        dedupKey: "data_contract_drift:em_1:type_change:amount",
        metadata: { field: "amount" },
      },
      db,
    );
    expect(out).not.toBeNull();
    const params = captured[0]!.params;
    expect(params[1]).toBe("ws_1");
    expect(params[2]).toBe("u1");
    expect(params[3]).toBe("data_contract_drift");
    expect(params[6]).toBe("**details**");
    expect(params[8]).toBe("data_contract_drift:em_1:type_change:amount");
    expect(JSON.parse(String(params[9]))).toEqual({ field: "amount" });
  });

  it("returns null when the dedup partial unique index trips", async () => {
    const db: Queryable = {
      async query() {
        throw new Error(
          'duplicate key value violates unique constraint "notifications_active_dedup_idx"',
        );
      },
    };
    const out = await emitNotification(
      {
        workspaceId: "ws_1",
        userId: "u1",
        kind: "data_contract_drift",
        title: "Drift detected",
        dedupKey: "k",
      },
      db,
    );
    expect(out).toBeNull();
  });

  it("rethrows non-dedup errors", async () => {
    const db: Queryable = {
      async query() {
        throw new Error("connection terminated");
      },
    };
    await expect(
      emitNotification(
        { workspaceId: "ws_1", userId: "u1", kind: "k", title: "t" },
        db,
      ),
    ).rejects.toThrow(/connection terminated/);
  });

  it("treats null userId as workspace-wide notification", async () => {
    const { db, captured } = fakeDb([[row({ user_id: null })]]);
    await emitNotification(
      {
        workspaceId: "ws_1",
        userId: null,
        kind: "service_announcement",
        title: "Maintenance window",
      },
      db,
    );
    expect(captured[0]!.params[2]).toBeNull();
  });
});

describe("listNotifications", () => {
  it("returns user-targeted + workspace-wide for the user", async () => {
    const { db, captured } = fakeDb([[]]);
    await listNotifications("ws_1", "u1", {}, db);
    expect(captured[0]!.sql).toMatch(/workspace_id = \$1/);
    expect(captured[0]!.sql).toMatch(/user_id = \$2 OR user_id IS NULL/);
    expect(captured[0]!.params).toEqual(["ws_1", "u1"]);
  });

  it("filters to unread when onlyUnread=true", async () => {
    const { db, captured } = fakeDb([[]]);
    await listNotifications("ws_1", "u1", { onlyUnread: true }, db);
    expect(captured[0]!.sql).toMatch(/read_at IS NULL/);
  });
});

describe("countUnreadNotifications", () => {
  it("returns the numeric count", async () => {
    const { db } = fakeDb([[{ count: "7" }]]);
    expect(await countUnreadNotifications("ws_1", "u1", db)).toBe(7);
  });
  it("returns 0 when there are no rows", async () => {
    const { db } = fakeDb([[]]);
    expect(await countUnreadNotifications("ws_1", "u1", db)).toBe(0);
  });
});

describe("billing notification reconciliation", () => {
  it("resolves quota alerts that no longer match the current plan or usage", async () => {
    const { db, captured } = fakeDb([[]]);
    await resolveInactiveBillingNotifications("ws_1", db);
    expect(captured[0]!.sql).toMatch(/UPDATE notifications n/);
    expect(captured[0]!.sql).toMatch(/w\.plan = 'free'/);
    expect(captured[0]!.sql).toMatch(/billing_exempt/);
    expect(captured[0]!.sql).toMatch(/COALESCE\(up\.total_tasks, 0\) >= 10000/);
    expect(captured[0]!.params).toEqual(["ws_1"]);
  });

  it("reconciles before listing unread billing alerts", async () => {
    const { db, captured } = fakeDb([[], [row({ kind: "billing_usage_spike" })]]);
    const result = await listUnreadBillingNotifications("ws_1", "u1", db);
    expect(result).toHaveLength(1);
    expect(captured[0]!.sql).toMatch(/UPDATE notifications n/);
    expect(captured[1]!.sql).toMatch(/kind LIKE 'billing\\_%'/);
  });

  it("reconciles before counting unread billing alerts", async () => {
    const { db, captured } = fakeDb([[], [{ count: "2" }]]);
    expect(await countUnreadBillingNotifications("ws_1", "u1", db)).toBe(2);
    expect(captured[0]!.sql).toMatch(/UPDATE notifications n/);
    expect(captured[1]!.sql).toMatch(/count\(\*\)/);
  });
});

describe("markNotificationRead / markAllNotificationsRead", () => {
  it("markNotificationRead scopes to workspace + user (or shared) and unread", async () => {
    const { db, captured } = fakeDb([[]]);
    await markNotificationRead("notif_1", "ws_1", "u1", db);
    expect(captured[0]!.sql).toMatch(/UPDATE notifications/);
    expect(captured[0]!.sql).toMatch(/read_at IS NULL/);
    expect(captured[0]!.params).toEqual(["notif_1", "ws_1", "u1"]);
  });

  it("markAllNotificationsRead returns the affected row count", async () => {
    const db: Queryable = {
      async query() {
        return { rows: [], rowCount: 5 };
      },
    };
    expect(await markAllNotificationsRead("ws_1", "u1", db)).toBe(5);
  });
});
