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

  it("stamps every accepted document with the current bundle version", () => {
    const versions = acceptedDocumentVersions();
    expect(Object.keys(versions).sort()).toEqual(["acceptable-use", "privacy", "terms"]);
    for (const v of Object.values(versions)) expect(v).toBe(CURRENT_TERMS_VERSION);
  });
});
