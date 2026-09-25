import { describe, expect, it } from "vitest";
import { workspaceHandoffActionRewrite, workspaceHandoffLocation } from "../lib/workspace-handoff";

describe("workspaceHandoffLocation", () => {
  it("keeps the canonical dest path and copies the incoming query string", () => {
    const loc = workspaceHandoffLocation(
      "https://app.axelapp.ai/workspaces/ws_1/deliveries?status=failed&q=timeout",
      "/deliveries",
    );
    expect(loc.pathname).toBe("/deliveries");
    expect(loc.search).toBe("?status=failed&q=timeout");
  });

  it("drops any query that was on destPath in favour of the request", () => {
    const loc = workspaceHandoffLocation(
      "https://app.axelapp.ai/workspaces/ws_1/inbox?muted=1",
      "/inbox",
    );
    expect(loc.pathname).toBe("/inbox");
    expect(loc.search).toBe("?muted=1");
  });
});

describe("workspaceHandoffActionRewrite", () => {
  it("sends server actions posted to a hand-off URL to the canonical page", () => {
    expect(workspaceHandoffActionRewrite("/workspaces/ws_sJxczjk3qWFlLgogE4wCyw/inbox")).toBe("/inbox");
    expect(workspaceHandoffActionRewrite("/workspaces/ws_1/deliveries/")).toBe("/deliveries");
  });

  it("leaves every other path alone", () => {
    expect(workspaceHandoffActionRewrite("/inbox")).toBeNull();
    expect(workspaceHandoffActionRewrite("/workspaces/ws_1/settings")).toBeNull();
    expect(workspaceHandoffActionRewrite("/workspaces/ws_1/inbox/extra")).toBeNull();
    expect(workspaceHandoffActionRewrite("/workspaces//inbox")).toBeNull();
  });
});
