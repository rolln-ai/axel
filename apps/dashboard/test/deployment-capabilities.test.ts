import { describe, expect, it } from "vitest";
import { deploymentCapabilities } from "../lib/deployment-capabilities";

describe("deployment capabilities", () => {
  it("disables controls the small self-host profile cannot enforce", () => {
    expect(deploymentCapabilities({ AXEL_SELF_HOST_PROFILE: "small" })).toEqual({
      configurableRawPayloadRetention: false,
      indexedSubjectErasure: false,
    });
  });

  it("keeps the full production path enabled by default", () => {
    expect(deploymentCapabilities({})).toEqual({
      configurableRawPayloadRetention: true,
      indexedSubjectErasure: true,
    });
  });
});
