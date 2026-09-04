import { describe, expect, it } from "vitest";
import { sendBillingEmail } from "../lib/billing/emails";
import type { Queryable } from "../lib/db";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

describe("sendBillingEmail", () => {
  it("stores no task, invoice, or message metadata in the idempotency journal payload", async () => {
    const queries: RecordedQuery[] = [];
    const pg: Queryable = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        if (/INSERT INTO billing_events/.test(sql)) {
          return { rows: [{ id: params[0] }] as T[], rowCount: 1 };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    };

    const result = await sendBillingEmail(
      {
        workspaceId: "ws_sensitive",
        workspaceName: "Private Customer Workspace",
        kind: "usage_spike",
        tasksThisPeriod: 987_654_321,
        estimatedCents: 123_456,
        periodEndLabel: "Confidential period label",
      },
      { pg },
    );

    expect(result).toEqual({ sent: false, recipients: 0, deduped: false });
    const journalInsert = queries.find((query) => /INSERT INTO billing_events/.test(query.sql));
    expect(journalInsert?.sql).toContain("'{}'::jsonb");
    expect(journalInsert?.sql).not.toContain("$4::jsonb");
    expect(journalInsert?.params).toHaveLength(3);
    expect(journalInsert?.params[1]).toBe("email.usage_spike");
    expect(journalInsert?.params[2]).toBe("ws_sensitive");
    const storedParameters = JSON.stringify(journalInsert?.params);
    expect(storedParameters).not.toContain("Private Customer Workspace");
    expect(storedParameters).not.toContain("987654321");
    expect(storedParameters).not.toContain("123456");
    expect(storedParameters).not.toContain("Confidential period label");
  });
});
