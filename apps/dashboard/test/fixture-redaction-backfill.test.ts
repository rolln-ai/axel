import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../lib/db";
import { backfillRedactFixtures } from "../lib/data-contracts/fixture-redaction-backfill";

// A version whose transform maps the sensitive field through to the output.
const MAPPING = { kind: "mongodb", id_path: null, projected_paths: ["type", "customer.email"] };
const INFERRED = {
  event_types: [],
  fields: {},
  ids: [],
  timestamps: [],
  status_fields: [],
  sensitive_fields: [],
  summary: "",
  model_metadata: { model: null, prompt_version: "v1", sample_count: 0, llm_enriched: false, ms: null },
};

function pgWith(firstPage: unknown[]): { query: ReturnType<typeof vi.fn>; updates: Array<[string, unknown[]]> } {
  const updates: Array<[string, unknown[]]> = [];
  let served = false;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("UPDATE data_contract_fixtures")) {
      updates.push([sql, params ?? []]);
      return { rows: [], rowCount: 1 };
    }
    // SELECT page: serve the batch once, then empty (drained).
    if (served) return { rows: [], rowCount: 0 };
    served = true;
    return { rows: firstPage, rowCount: firstPage.length };
  });
  return { query, updates };
}

describe("backfillRedactFixtures", () => {
  it("masks input, recomputes expected from the redacted input, and rewrites the row", async () => {
    const { query, updates } = pgWith([
      {
        id: "emf_1",
        input_payload: { type: "a", customer: { email: "alice@example.com" } },
        inferred_schema: INFERRED,
        destination_mapping: MAPPING,
      },
    ]);
    const result = await backfillRedactFixtures({ pg: { query } as unknown as Queryable });

    expect(result).toEqual({ processed: 1, skipped: 0, done: true });
    expect(updates).toHaveLength(1);
    const [, params] = updates[0]!;
    const maskedInput = JSON.parse(params[1] as string);
    const expected = JSON.parse(params[2] as string);
    expect(maskedInput).toEqual({ type: "a", customer: { email: "[REDACTED]" } });
    // The transform projects customer.email → the redacted value flows through.
    expect(JSON.stringify(expected)).not.toContain("alice@example.com");
    expect(JSON.stringify(expected)).toContain("[REDACTED]");
  });

  it("skips rows with no destination_mapping rather than risk breaking the gate", async () => {
    const { query, updates } = pgWith([
      {
        id: "emf_2",
        input_payload: { email: "bob@x.com" },
        inferred_schema: INFERRED,
        destination_mapping: null,
      },
    ]);
    const result = await backfillRedactFixtures({ pg: { query } as unknown as Queryable });

    expect(result).toEqual({ processed: 0, skipped: 1, done: true });
    expect(updates).toHaveLength(0);
  });
});
