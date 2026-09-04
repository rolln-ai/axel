import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONSENT_DOCUMENTS, CURRENT_TERMS_VERSION, acceptedDocumentVersions } from "../lib/legal";

describe("clickwrap consent constants", () => {
  it("covers the three documents the signup checkbox names", () => {
    expect(CONSENT_DOCUMENTS.map((d) => d.slug)).toEqual(["terms", "acceptable-use", "privacy"]);
  });

  it("points every consent link at the marketing legal pages", () => {
    for (const doc of CONSENT_DOCUMENTS) {
      expect(doc.href).toMatch(/^https?:\/\/.+\/(terms|acceptable-use|privacy)$/);
    }
  });

  it("stamps each accepted document with its published version", () => {
    const versions = acceptedDocumentVersions();
    expect(Object.keys(versions).sort()).toEqual(["acceptable-use", "privacy", "terms"]);
    for (const doc of CONSENT_DOCUMENTS) expect(versions[doc.slug]).toBe(doc.version);
    expect(versions.terms).toBe(CURRENT_TERMS_VERSION);
  });

  it("matches the versions published by the marketing legal documents", () => {
    for (const doc of CONSENT_DOCUMENTS) {
      const source = readFileSync(
        new URL(`../../marketing/content/legal/${doc.slug}.md`, import.meta.url),
        "utf8",
      );
      expect(source).toMatch(new RegExp(`^version: ["']${doc.version}["']$`, "m"));
    }
  });
});
