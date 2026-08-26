import { describe, expect, it } from "vitest";
import {
  getNotificationPreferences,
  upsertNotificationPreferences,
} from "../lib/notifications";
import type { Queryable } from "../lib/db";

function fakeClient(rows: unknown[]): {
  client: Queryable;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: Queryable = {
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
  return { client, calls };
}

describe("getNotificationPreferences", () => {
  it("defaults every channel to ON when there's no row", async () => {
    const { client } = fakeClient([]);
    expect(await getNotificationPreferences("ws1", "u1", client)).toEqual({
      email_digest_daily: true,
      email_immediate: true,
    });
  });

  it("honours an explicit opt-out and leaves the other channel on", async () => {
    const { client } = fakeClient([{ prefs: { email_immediate: false } }]);
    expect(await getNotificationPreferences("ws1", "u1", client)).toEqual({
      email_digest_daily: true,
      email_immediate: false,
    });
  });
});

describe("upsertNotificationPreferences", () => {
  it("merges only the changed keys into the prefs JSONB", async () => {
    const { client, calls } = fakeClient([]);
    await upsertNotificationPreferences("ws1", "u1", { email_immediate: false }, client);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("ON CONFLICT");
    expect(calls[0]!.sql).toContain("prefs ||");
    expect(calls[0]!.params).toEqual(["ws1", "u1", JSON.stringify({ email_immediate: false })]);
  });
});
