import { describe, expect, it } from "vitest";
import { requireActiveWorkspace, requireWritableRole } from "../lib/auth-guards";

// These shared gates are now applied by actions.ts, inbox-actions.ts, and the
// data-contracts refresh action. The audit found drift (some actions skipped
// them), so pin the behavior the whole surface depends on.
describe("auth-guards (shared mutation gates)", () => {
  it("requireWritableRole allows owner/admin, blocks member", () => {
    expect(requireWritableRole("owner")).toBeNull();
    expect(requireWritableRole("admin")).toBeNull();
    expect(requireWritableRole("member")).toMatch(/owners and admins/i);
  });

  it("requireActiveWorkspace allows active, blocks suspended/deleted", () => {
    expect(requireActiveWorkspace({ workspace_status: "active" })).toBeNull();
    expect(requireActiveWorkspace({ workspace_status: "suspended" })).toMatch(/suspended/i);
    expect(requireActiveWorkspace({ workspace_status: "deleted" })).toMatch(/no longer available/i);
  });
});
