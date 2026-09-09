import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WebhookSetupDetails } from "../app/_components/WebhookSetupDetails";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sourceAuthenticatedUrl,
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
  it("keeps header tokens out of legacy query URLs and public guidance", () => {
    const boundaryFiles = [
      "apps/dashboard/app/(app)/_components/FirstRunSetupFlow.tsx",
      "apps/dashboard/app/_components/WebhookSetupDetails.tsx",
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
  it("builds a full URL only from a dedicated URL credential", () => {
    const token = `axu_${"u".repeat(43)}`;
    const endpoint = "https://ingest.example.test/in/src_test";
    const url = new URL(sourceAuthenticatedUrl(endpoint, token));
    expect(url.origin + url.pathname).toBe(endpoint);
    expect([...url.searchParams]).toEqual([["url_token", token]]);
    expect(() => sourceAuthenticatedUrl(endpoint, "axt_header-token")).toThrow();
    expect(() => sourceAuthenticatedUrl(endpoint + "?token=old", token)).toThrow();
  });

  it("renders the current header value with its complete endpoint and named copy controls", () => {
    const html = renderToStaticMarkup(createElement(WebhookSetupDetails, {
      ingestUrl: "https://ingest.example.test/in/src_test", provider: "custom", token: "synthetic-new-token",
    }));
    expect(html).toContain("synthetic-new-token");
    expect(html).toContain('aria-label="Copy URL"');
    expect(html).toContain('aria-label="Copy header name"');
    expect(html).toContain('aria-label="Copy header value"');
    expect(html).not.toContain("YOUR_SOURCE_TOKEN");
  });

  it("does not copy a placeholder or request a custom header for a named provider", () => {
    for (const provider of ["custom", "stripe", "github", "shopify", "chargebee"] as const) {
      const html = renderToStaticMarkup(createElement(WebhookSetupDetails, {
        ingestUrl: "https://ingest.example.test/in/src_test", provider,
      }));
      expect(html).not.toContain('aria-label="Copy header value"');
      expect(html).not.toContain("YOUR_SOURCE_TOKEN");
      if (provider !== "custom") expect(html).not.toContain("x-axel-token");
    }
  });

});
