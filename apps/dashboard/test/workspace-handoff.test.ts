import { describe, expect, it } from "vitest";
import { workspaceHandoffLocation } from "../lib/workspace-handoff";

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
