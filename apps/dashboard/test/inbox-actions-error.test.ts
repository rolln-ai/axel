import { describe, expect, it } from "vitest";
import {
  humanRepairError,
  humanRepairErrorFromCaught,
} from "../lib/inbox-repair-error";

describe("inbox repair errors", () => {
  it("turns BigQuery's live streams error into recovery guidance", () => {
    expect(humanRepairError(
      "Table `data` cannot change column types via SET DATA TYPE because it has streams attached.",
    )).toBe(
      "BigQuery has an active streaming buffer and will not change this type yet. Pause deliveries to this table, wait for the buffer to clear (usually up to 5 hours), then run Fix data again.",
    );
  });

  it("does not reflect unrecognized provider or database details", () => {
    const marker = "postgresql://user:marker-secret@private-db.internal/marker_schema";
    const result = humanRepairError(`provider rejected SQL: ${marker}`);

    expect(result).toBe(
      "Could not apply this fix. Review the destination configuration and try again.",
    );
    expect(result).not.toContain(marker);
    expect(result).not.toContain("private-db.internal");
  });

  it("maps caught exceptions through the fixed public-error boundary", () => {
    const marker = "https://private-provider.invalid/hook?token=marker-secret";
    const result = humanRepairErrorFromCaught(new Error(marker), "Fallback");

    expect(result).toBe(
      "Could not apply this fix. Review the destination configuration and try again.",
    );
    expect(result).not.toContain(marker);
  });
});
