import { describe, expect, it } from "vitest";
import { buildDbPullConnector, isDbPullType, type DbPullSourceType } from "../lib/pull-db-connectors";

// Regression for the release-audit critical: dashboard "Sync now"
// (runDashboardPullSync) always errored for postgres/mongodb/bigquery
// sources because they were dispatched through the SaaS-only readPage path,
// which throws `pull_sync_dispatch_error` for any non-SaaS type. The fix
// routes DB types through buildDbPullConnector + runPullSync instead.
describe("pull DB-vs-SaaS dispatch (release-audit fix)", () => {
  it("classifies the three database pull types as DB pulls", () => {
    expect(isDbPullType("postgres")).toBe(true);
    expect(isDbPullType("mongodb")).toBe(true);
    expect(isDbPullType("bigquery")).toBe(true);
  });

  it("classifies SaaS pull types as NOT DB pulls (they keep the inline readPage path)", () => {
    expect(isDbPullType("chargebee")).toBe(false);
    expect(isDbPullType("stripe")).toBe(false);
    expect(isDbPullType("shopify")).toBe(false);
  });

  // runPullSync guards `connector.type !== source.type` — a mismatch here
  // would make every DB sync throw, so pin the wiring per type.
  it.each(["postgres", "mongodb", "bigquery"] as DbPullSourceType[])(
    "builds a %s connector whose type matches the source (runPullSync guard)",
    (type) => {
      const connector = buildDbPullConnector(type);
      expect(connector.type).toBe(type);
      expect(typeof connector.streams).toBe("function");
    },
  );
});
