import { describe, expect, it } from "vitest";
import { humanRepairError } from "../lib/inbox-repair-error";

describe("inbox repair errors", () => {
  it("turns BigQuery's live streams error into recovery guidance", () => {
    expect(humanRepairError(
      "Table `data` cannot change column types via SET DATA TYPE because it has streams attached.",
    )).toBe(
      "BigQuery has an active streaming buffer and will not change this type yet. Pause deliveries to this table, wait for the buffer to clear (usually up to 5 hours), then run Fix data again.",
    );
  });
});
