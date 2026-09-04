import { describe, expect, it } from "vitest";
import { cacheTags, workspaceCacheScope } from "../lib/repositories";

describe("dashboard cache key privacy", () => {
  it("uses a stable opaque scope instead of a raw workspace identifier", () => {
    const workspaceId = "workspace-private-marker";
    const scope = workspaceCacheScope(workspaceId);

    expect(scope).toMatch(/^[0-9a-f]{24}$/);
    expect(workspaceCacheScope(workspaceId)).toBe(scope);
    expect(workspaceCacheScope("workspace-other-marker")).not.toBe(scope);
    for (const tag of Object.values(cacheTags).map((makeTag) => makeTag(workspaceId))) {
      expect(tag).toContain(scope);
      expect(tag).not.toContain(workspaceId);
    }
  });
});
