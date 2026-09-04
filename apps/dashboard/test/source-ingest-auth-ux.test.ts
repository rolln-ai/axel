import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sourceAuthenticationCopy,
  sourceAuthHeaderExample,
  sourceUsesAxelToken,
} from "../lib/source-ingest-auth";

const repoRoot = resolve(import.meta.dirname, "../../..");
const queryTokenAssignment = `${String.fromCharCode(63)}token=`;

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("source ingest authentication UX", () => {
  it("keeps source credentials out of copyable URLs and public guidance", () => {
    const boundaryFiles = [
      "apps/dashboard/app/(app)/_components/FirstRunSetupFlow.tsx",
      "apps/dashboard/app/(app)/sources/NewSourcePipelineDialog/index.tsx",
      "apps/dashboard/app/(app)/sources/NewSourcePipelineDialog/steps/ActivationStep.tsx",
      "apps/dashboard/app/(app)/sources/NewSourcePipelineDialog/steps/shared.tsx",
      "apps/dashboard/app/(app)/sources/SourceQuickView.tsx",
      "apps/dashboard/app/(app)/sources/[id]/SourceTokenPanel.tsx",
      "apps/dashboard/app/(app)/sources/[id]/page.tsx",
      "apps/dashboard/public/openapi.yaml",
      "apps/marketing/app/security/page.tsx",
      "README.md",
      "docs/adr-0001-architecture.md",
      "docs/postman/README.md",
      "docs/security-review-2026-08.md",
      "packages/cli/README.md",
      "scripts/load/README.md",
      "scripts/load/ingest-load.js",
    ];

    for (const file of boundaryFiles) {
      expect(read(file), file).not.toContain(queryTokenAssignment);
    }
  });

  it("uses the Axel header only for custom sources", () => {
    expect(sourceUsesAxelToken("custom")).toBe(true);
    expect(sourceAuthHeaderExample("custom")).toBe(
      "x-axel-token: YOUR_SOURCE_TOKEN",
    );
    expect(sourceAuthenticationCopy("custom")).toContain("x-axel-token");

    for (const provider of ["stripe", "github", "shopify", "chargebee"] as const) {
      expect(sourceUsesAxelToken(provider)).toBe(false);
      expect(sourceAuthHeaderExample(provider).toLowerCase()).not.toContain("x-axel-token");
      expect(sourceAuthenticationCopy(provider).toLowerCase()).toContain(
        "without an axel source token",
      );
    }
  });

  it("keeps the load harness on header authentication", () => {
    const source = read("scripts/load/ingest-load.js");
    expect(source).toContain('"x-axel-token": SOURCE_TOKEN');
    expect(source).not.toContain("AUTH_MODE");
    expect(source).not.toContain("headers.authorization");
  });

  it("documents each named provider authentication alternative", () => {
    const spec = read("apps/dashboard/public/openapi.yaml");
    expect(spec).toContain("StripeSignature: []");
    expect(spec).toContain("GitHubSignature: []");
    expect(spec).toContain("ShopifySignature: []");
    expect(spec).toContain("ChargebeeBasic: []");
    expect(spec).toContain("query_token_not_allowed");
  });
});
