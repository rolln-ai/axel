import { afterEach, describe, expect, it, vi } from "vitest";

const { dbMock, safeDashboardFetchMock } = vi.hoisted(() => ({
  dbMock: vi.fn(),
  safeDashboardFetchMock: vi.fn(),
}));

vi.mock("../lib/db", () => ({ db: dbMock }));
vi.mock("../lib/safe-egress", () => ({ safeDashboardFetch: safeDashboardFetchMock }));

import { runDashboardPullSync } from "../lib/pull-sync";

afterEach(() => {
  vi.clearAllMocks();
});

describe("dashboard authenticated SaaS pull egress", () => {
  it.each([
    {
      type: "stripe",
      stream: "customers",
      config: { api_key: "sk_test_source_secret" },
      expectedUrl: /^https:\/\/api\.stripe\.com\//,
      expectedHeader: ["authorization", "Bearer sk_test_source_secret"],
      expectedError: /Stripe connection failed with HTTP 302/,
    },
    {
      type: "shopify",
      stream: "orders",
      config: { shop: "acme.myshopify.com", access_token: "shopify_source_secret" },
      expectedUrl: /^https:\/\/acme\.myshopify\.com\//,
      expectedHeader: ["x-shopify-access-token", "shopify_source_secret"],
      expectedError: /Shopify connection failed with HTTP 302/,
    },
  ] as const)(
    "uses the protected fetch and refuses $type redirects",
    async ({ type, stream, config, expectedUrl, expectedHeader, expectedError }) => {
      installPullSource(type, stream, config);
      safeDashboardFetchMock.mockResolvedValue(new Response("redirect", {
        status: 302,
        headers: { location: "https://attacker.example/steal" },
      }));

      await expect(runDashboardPullSync({
        sourceId: `src_${type}`,
        workspaceId: "ws_1",
        actorUserId: "usr_1",
      })).rejects.toThrow(expectedError);

      expect(safeDashboardFetchMock).toHaveBeenCalledOnce();
      const [url, init] = safeDashboardFetchMock.mock.calls[0] ?? [];
      expect(String(url)).toMatch(expectedUrl);
      expect(init).toMatchObject({ redirect: "manual" });
      expect(init?.headers).toMatchObject({ [expectedHeader[0]]: expectedHeader[1] });
      expect(safeDashboardFetchMock.mock.calls.some(([requested]) =>
        String(requested).includes("attacker.example")
      )).toBe(false);
    },
  );
});

function installPullSource(
  type: "stripe" | "shopify",
  stream: "customers" | "orders",
  config: Record<string, unknown>,
): void {
  const databaseQuery = vi.fn(async (sql: string, _params: unknown[] = []) => {
    if (sql.includes("FROM pull_sources ps")) {
      return {
        rows: [{
          id: `src_${type}`,
          workspace_id: "ws_1",
          name: type,
          type,
          config: {
            ...config,
            ingest_token: "ingest-token",
            streams: [{ name: stream, selected: true }],
          },
          credentials_ref: null,
          status: "active",
          ingest_status: "active",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM pull_source_stream_state")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const lockClient = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      return databaseQuery(sql, params);
    }),
    release: vi.fn(),
  };
  dbMock.mockReturnValue({
    connect: vi.fn(async () => lockClient),
    query: databaseQuery,
  });
}
