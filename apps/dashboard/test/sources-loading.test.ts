import { expect, it, vi } from "vitest";
import SourcesPage from "../app/(app)/sources/page";
import { requireSession } from "../lib/session";
import { listSources } from "../lib/repositories";
import { listDestinationsWithRouteCount } from "../lib/destinations";
import { getSourceEventCountsByWindowCached, usageEnabled } from "../lib/usage";

vi.mock("../lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("../lib/db", () => ({ db: vi.fn(), withTransaction: vi.fn() }));
vi.mock("../lib/repositories", async (original) => ({
  ...await original<typeof import("../lib/repositories")>(), listSources: vi.fn(),
}));
vi.mock("../lib/destinations", async (original) => ({
  ...await original<typeof import("../lib/destinations")>(), listDestinationsWithRouteCount: vi.fn(),
}));
vi.mock("../lib/usage", async (original) => ({
  ...await original<typeof import("../lib/usage")>(),
  usageEnabled: vi.fn(), getSourceEventCountsByWindowCached: vi.fn(),
}));

it("returns usable sources without waiting for slow analytics", async () => {
  vi.mocked(requireSession).mockResolvedValue({
    activeWorkspace: { workspace_id: "ws_test", role: "owner" },
  } as Awaited<ReturnType<typeof requireSession>>);
  vi.mocked(listSources).mockResolvedValue([{
    id: "src_test", name: "Synthetic webhook", status: "active", source_kind: "webhook",
    provider: "custom", max_events_per_minute: 100, created_at: "2026-09-01T00:00:00Z",
  }]);
  vi.mocked(listDestinationsWithRouteCount).mockResolvedValue([]);
  vi.mocked(usageEnabled).mockReturnValue(true);
  let release!: () => void;
  vi.mocked(getSourceEventCountsByWindowCached).mockReturnValue(new Promise((resolve) => {
    release = () => resolve([]);
  }));
  let returned = false;
  const page = SourcesPage().then((value) => { returned = true; return value; });
  try {
    await vi.waitFor(() => expect(returned).toBe(true), { timeout: 250, interval: 10 });
    expect(await page).toBeTruthy();
    expect(getSourceEventCountsByWindowCached).toHaveBeenCalledWith("ws_test");
  } finally {
    release();
  }
});
