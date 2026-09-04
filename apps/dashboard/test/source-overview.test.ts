import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceOverview } from "../app/(app)/sources/[id]/SourceOverview";
import { usageEnabled, listSourceEvents, getSourceEventStats, getSourceDailyUsage } from "../lib/usage";

vi.mock("../lib/usage", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/usage")>(),
  usageEnabled: vi.fn(),
  listSourceEvents: vi.fn(),
  getSourceEventStats: vi.fn(),
  getSourceDailyUsage: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(usageEnabled).mockReturnValue(true);
  vi.mocked(listSourceEvents).mockReset().mockResolvedValue([]);
  vi.mocked(getSourceEventStats).mockResolvedValue({
    total_events: 0, events_24h: 0, bytes_total: 0, first_seen: null, last_seen: null,
  });
  vi.mocked(getSourceDailyUsage).mockResolvedValue([]);
});

const props = {
  source: { id: "src_test", status: "active" as const, routes_attached: 2 },
  workspaceId: "ws_test",
  timezone: "UTC",
};

it("does not present unavailable analytics as a zero-event chart", async () => {
  vi.mocked(usageEnabled).mockReturnValue(false);
  const html = renderToStaticMarkup(await SourceOverview(props));
  expect(html).toContain("Source analytics unavailable");
  expect(html).not.toContain("Daily event stream");
  expect(html).not.toContain("no events yet");
  expect(html).not.toContain("last 0 of");
  expect(vi.mocked(listSourceEvents)).not.toHaveBeenCalled();
});

it("distinguishes a failed analytics query from an empty source without exposing provider errors", async () => {
  vi.mocked(listSourceEvents).mockRejectedValue(new Error("private provider response"));
  const html = renderToStaticMarkup(await SourceOverview(props));
  expect(html).toContain("temporarily unavailable");
  expect(html).not.toContain("private provider response");
  expect(html).not.toContain("Daily event stream");
  expect(html).not.toContain("No events yet");
});

it("renders the zero-event chart after a successful empty query", async () => {
  const html = renderToStaticMarkup(await SourceOverview(props));
  expect(html).toContain("Daily event stream for the last 14 days");
  expect(html).toContain("No events yet");
  expect(html).not.toContain("Source analytics unavailable");
});
