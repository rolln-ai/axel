import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardRoot = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(dashboardRoot, relativePath), "utf8");
}

describe("dashboard analytics egress", () => {
  it("does not load an identified product-analytics SDK or proxy", () => {
    const boundaryFiles = [
      "package.json",
      "next.config.mjs",
      "instrumentation-client.ts",
      "app/layout.tsx",
      "app/(app)/layout.tsx",
    ];

    for (const file of boundaryFiles) {
      const source = read(file).toLowerCase();
      expect(source, file).not.toContain("posthog");
      expect(source, file).not.toContain("captureserverevent");
    }
  });
});
