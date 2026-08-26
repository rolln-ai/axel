import { describe, expect, it } from "vitest";
import { deriveCheckoutReturnNotice } from "../lib/billing/checkout-return-notice";

describe("deriveCheckoutReturnNotice", () => {
  it("returns a success notice for checkout=success", () => {
    const notice = deriveCheckoutReturnNotice("success");
    expect(notice).toMatchObject({ tone: "success" });
    expect(notice?.title).toMatch(/welcome to pro/i);
  });

  it("returns an informational notice for checkout=cancel", () => {
    const notice = deriveCheckoutReturnNotice("cancel");
    expect(notice).toMatchObject({ tone: "info" });
    expect(notice?.title).toMatch(/canceled/i);
    // The cancel copy must make clear nothing changed.
    expect(notice?.body).toMatch(/no changes/i);
  });

  it("returns null when the param is absent", () => {
    expect(deriveCheckoutReturnNotice(undefined)).toBeNull();
  });

  it("returns null for unexpected values (params are attacker-controllable)", () => {
    expect(deriveCheckoutReturnNotice("")).toBeNull();
    expect(deriveCheckoutReturnNotice("SUCCESS")).toBeNull();
    expect(deriveCheckoutReturnNotice("succeeded")).toBeNull();
    expect(deriveCheckoutReturnNotice("<script>")).toBeNull();
  });
});
