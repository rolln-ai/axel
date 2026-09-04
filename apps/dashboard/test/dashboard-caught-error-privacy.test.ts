import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const actionFiles = [
  "../lib/data-contracts/actions.ts",
  "../lib/data-contracts/refresh.ts",
  "../lib/data-contracts/destination-actions.ts",
  "../lib/data-contracts/codegen-actions.ts",
  "../lib/pipeline-proposals.ts",
  "../lib/erasure-executor.ts",
  "../lib/erasure-lifecycle.ts",
  "../lib/inbox-actions.ts",
] as const;

describe("dashboard caught-error privacy boundaries", () => {
  for (const relativePath of actionFiles) {
    it(`does not reflect caught exception text from ${relativePath}`, () => {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

      expect(source).not.toMatch(
        /\b(?:err|error)\s+instanceof Error\s*\?\s*(?:err|error)\.message/,
      );
      expect(source).not.toMatch(/String\((?:err|error)\)/);
    });
  }

  it("keeps erasure failures as fixed audit codes", () => {
    const executor = readFileSync(
      new URL("../lib/erasure-executor.ts", import.meta.url),
      "utf8",
    );
    const lifecycle = readFileSync(
      new URL("../lib/erasure-lifecycle.ts", import.meta.url),
      "utf8",
    );

    expect(executor).toContain('detail: "clickhouse_delete_failed"');
    expect(executor).toContain('detail: "postgres_delete_failed"');
    expect(lifecycle).toContain('detail: "store_operation_failed"');
    expect(lifecycle).not.toMatch(/error_message[\s\S]{0,300}\.message/);
  });

  it("does not log email arguments in the development fallback", () => {
    const source = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
    const consoleStatements = source
      .split("\n")
      .filter((line) => /console\.(?:log|warn|error)/.test(line))
      .join("\n");

    expect(consoleStatements).not.toMatch(/args\.(?:to|subject|text|html)/);
    expect(consoleStatements).not.toContain("body:");
  });
});
