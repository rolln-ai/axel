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

describe("dashboard Chargebee pull egress", () => {
  it("rejects a legacy custom domain before opening a request", async () => {
    installPullSource({ domain: "attacker.example" });

    await expect(runDashboardPullSync({
      sourceId: "src_chargebee",
      workspaceId: "ws_1",
      actorUserId: "usr_1",
    })).rejects.toThrow(/^operation_failed$/);

    expect(safeDashboardFetchMock).not.toHaveBeenCalled();
  });

  it("keeps redirects manual and never forwards the Basic credential", async () => {
    installPullSource({ domain: "chargebee.com" });
    safeDashboardFetchMock.mockResolvedValue(new Response("redirect", {
      status: 302,
      headers: { location: "http://127.0.0.1/metadata" },
    }));

    await expect(runDashboardPullSync({
      sourceId: "src_chargebee",
      workspaceId: "ws_1",
      actorUserId: "usr_1",
    })).rejects.toThrow(/^http_error_302$/);

    expect(safeDashboardFetchMock).toHaveBeenCalledTimes(1);
    expect(safeDashboardFetchMock).toHaveBeenCalledWith(
      "https://acme-test.chargebee.com/api/v2/customers?limit=100&sort_by%5Basc%5D=updated_at",
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ authorization: "Basic dGVzdF9rZXk6" }),
      }),
    );
    expect(safeDashboardFetchMock.mock.calls.some(([url]) => String(url).includes("127.0.0.1")))
      .toBe(false);
  });

  it("binds a credential lookup to the parent workspace and pull source", async () => {
    const query = installPullSource({ domain: "chargebee.com" }, "cred_other");

    await expect(runDashboardPullSync({
      sourceId: "src_chargebee",
      workspaceId: "ws_1",
      actorUserId: "usr_1",
    })).rejects.toThrow("pull_credential_not_found");

    const credentialCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM pull_source_credentials")
    );
    expect(String(credentialCall?.[0])).toContain("AND workspace_id = $2");
    expect(String(credentialCall?.[0])).toContain("AND pull_source_id = $3");
    expect(credentialCall?.[1]).toEqual(["cred_other", "ws_1", "src_chargebee"]);
  });

  it("does not retain an upstream response body in the run row or caller error", async () => {
    const query = installPullSource({ domain: "chargebee.com" });
    const cancel = vi.fn(async () => undefined);
    const readBody = vi.fn(async () =>
      'payload={"email":"victim@example.com"} api_key=sk_live_response_secret'
    );
    safeDashboardFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      body: { cancel },
      text: readBody,
    });

    let message = "";
    try {
      await runDashboardPullSync({
        sourceId: "src_chargebee",
        workspaceId: "ws_1",
        actorUserId: "usr_1",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("http_error_500");
    expect(readBody).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    const persisted = JSON.stringify(
      query.mock.calls
        .filter(([sql]) => String(sql).includes("UPDATE pull_sync_runs"))
        .map(([, params]) => params),
    );
    expect(persisted).toContain("http_error_500");
    expect(persisted).not.toContain("Chargebee connection failed");
    expect(persisted).not.toContain("victim@example.com");
    expect(persisted).not.toContain("sk_live_response_secret");
  });
});

function installPullSource(
  extraConfig: Record<string, unknown>,
  credentialsRef: string | null = null,
) {
  const databaseQuery = vi.fn(async (sql: string, _params: unknown[] = []) => {
    if (sql.includes("FROM pull_sources ps")) {
      return {
        rows: [{
          id: "src_chargebee",
          workspace_id: "ws_1",
          name: "Chargebee",
          type: "chargebee",
          config: {
            site: "acme-test",
            api_key: "test_key",
            ingest_token: "ingest-token",
            streams: [{ name: "customers", selected: true }],
            ...extraConfig,
          },
          credentials_ref: credentialsRef,
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
  return databaseQuery;
}
