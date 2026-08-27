import "server-only";
import { runTransform } from "@axel/shared";
import { db, type Queryable } from "../db";
import { generateRouteArtifacts } from "./codegen";
import type { DestinationMapping } from "./destination-mapping";
import { redactFixturePayload } from "./fixture-redaction";
import type { InferredDataContract } from "./inference";

export interface FixtureBackfillResult {
  /** Rows masked and rewritten. */
  processed: number;
  /** Rows skipped (no destination_mapping, or transform reconstruction failed). */
  skipped: number;
  /** False only if the row cap was hit before the table was drained. */
  done: boolean;
}

interface FixtureRow {
  id: string;
  input_payload: unknown;
  inferred_schema: unknown;
  destination_mapping: unknown;
}

/**
 * Legacy mask-in-place backfill for installations that have not applied
 * migration 0069 yet. For each row we
 * reconstruct the version's (purely structural) transform from its stored
 * `destination_mapping`, redact the stored input, and recompute `expected_output`
 * from the redacted input — so the fixture pair stays consistent with what the
 * activation gate will replay, while both columns are freed of PII.
 *
 * Idempotent: redaction of already-masked data is a no-op, so re-running is safe.
 * Cursor-paged by `id`; drains the whole table in one call unless `maxRows` caps it.
 */
export async function backfillRedactFixtures(
  opts: { batchSize?: number; maxRows?: number; pg?: Queryable } = {},
): Promise<FixtureBackfillResult> {
  const pg = opts.pg ?? db();
  const batchSize = opts.batchSize ?? 500;
  const maxRows = opts.maxRows ?? 200_000;
  let cursor = "";
  let processed = 0;
  let skipped = 0;
  let scanned = 0;

  for (;;) {
    const { rows } = await pg.query<FixtureRow>(
      `SELECT f.id, f.input_payload, v.inferred_schema, v.destination_mapping
         FROM data_contract_fixtures f
         JOIN data_contract_versions v ON v.id = f.data_contract_version_id
        WHERE f.id > $1
        ORDER BY f.id
        LIMIT $2`,
      [cursor, batchSize],
    );
    if (rows.length === 0) return { processed, skipped, done: true };

    for (const row of rows) {
      cursor = row.id;
      scanned += 1;
      // No mapping → can't reconstruct the transform to keep the pair
      // consistent; skip rather than risk breaking the activation gate.
      if (row.destination_mapping == null) {
        skipped += 1;
        continue;
      }
      try {
        const { transform } = generateRouteArtifacts(
          row.inferred_schema as InferredDataContract,
          row.destination_mapping as DestinationMapping,
        );
        const maskedInput = redactFixturePayload(row.input_payload);
        const expected = runTransform(maskedInput, transform);
        await pg.query(
          `UPDATE data_contract_fixtures
              SET input_payload = $2::jsonb, expected_output = $3::jsonb
            WHERE id = $1`,
          [row.id, JSON.stringify(maskedInput), JSON.stringify(expected)],
        );
        processed += 1;
      } catch {
        skipped += 1;
      }
    }

    if (scanned >= maxRows) return { processed, skipped, done: false };
  }
}
