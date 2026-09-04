import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("investigation cache privacy", () => {
  it("never passes a failed webhook payload through Next persistent cache arguments", () => {
    const source = readFileSync(
      new URL(
        "../app/(app)/deliveries/[id]/investigate/page.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain("unstable_cache");
    expect(source).not.toContain("cachedExplainFailure");
    expect(source).toContain("explainFailure(failureContext)");
  });
});
