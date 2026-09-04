import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  invalidateEdgeSourceCache,
  requireEdgeSourceAuthoritySync,
  requireEdgeSourceFence,
  rowToEdgePayload,
  type SourceDbRow,
} from "../lib/edge-invalidation";
import { encryptSourceSigningSecret } from "../lib/source-secret";

const { dbQueryMock } = vi.hoisted(() => ({ dbQueryMock: vi.fn() }));
vi.mock("../lib/db", () => ({ db: () => ({ query: dbQueryMock }) }));

// Deterministic 32-byte dummy key for unit tests only — not a real secret. gitleaks:allow
const MASTER_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"; // gitleaks:allow

function sourceRow(overrides: Partial<SourceDbRow> = {}): SourceDbRow {
  return {
    id: "src_1",
    workspace_id: "ws_1",
    name: "Webhook source",
    secret_token_hash: "token-hash",
    status: "active",
    max_body_bytes: null,
    max_body_depth: null,
    max_events_per_minute: null,
    field_selection: null,
    provider: "custom",
    signing_secret_ciphertext: null,
    signing_secret_previous_ciphertext: null,
    redact_paths: null,
    ordering_enabled: false,
    ordering_key_header: null,
    ordering_key_path: null,
    subject_key_paths: null,
    inbound_ip_allowlist: [],
    ...overrides,
  };
}

describe("invalidateEdgeSourceCache", () => {
  it("is a no-op when neither URL nor token is configured", async () => {
    const fetchSpy = vi.fn();
    await invalidateEdgeSourceCache("src_1", { fetchImpl: fetchSpy as never, env: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when only one of URL or token is configured", async () => {
    const fetchSpy = vi.fn();
    await invalidateEdgeSourceCache("src_1", {
      fetchImpl: fetchSpy as never,
      env: { INGEST_ADMIN_URL: "https://x" },
    });
    await invalidateEdgeSourceCache("src_1", {
      fetchImpl: fetchSpy as never,
      env: { INGEST_ADMIN_TOKEN: "tk" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to the configured URL with the admin token header and source body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = (async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await invalidateEdgeSourceCache("src_42", {
      fetchImpl: fakeFetch,
      env: {
        INGEST_ADMIN_URL: "https://ingest.example.com/admin/source-cache/invalidate",
        INGEST_ADMIN_TOKEN: "tk-admin",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ingest.example.com/admin/source-cache/invalidate");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect((calls[0]?.init.headers as Record<string, string>)["x-axel-admin-token"]).toBe("tk-admin");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ source_id: "src_42" });
  });

  it("swallows fetch errors so the dashboard action still succeeds", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(invalidateEdgeSourceCache("src_x", {
      fetchImpl: fakeFetch,
      env: { INGEST_ADMIN_URL: "https://x", INGEST_ADMIN_TOKEN: "tk" },
    })).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("logs (but does not throw) on non-2xx responses other than 204", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeFetch: typeof fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await invalidateEdgeSourceCache("src_x", {
      fetchImpl: fakeFetch,
      env: { INGEST_ADMIN_URL: "https://x", INGEST_ADMIN_TOKEN: "tk" },
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("requireEdgeSourceFence", () => {
  it("rejects when the admin URL or token is missing", async () => {
    await expect(requireEdgeSourceFence("src_x", { env: {} }))
      .rejects.toThrow(/not configured/);
    await expect(requireEdgeSourceFence("src_x", {
      env: { INGEST_ADMIN_URL: "https://ingest.example.test" },
    })).rejects.toThrow(/not configured/);
  });

  it("uses the authority fence endpoint and returns a one-use token", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: typeof fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const fence = await requireEdgeSourceFence("src_x", {
      fetchImpl: fakeFetch,
      env: {
        INGEST_ADMIN_URL: "https://ingest.example.test/admin/source-authority/sync",
        INGEST_ADMIN_TOKEN: "tk",
      },
    });

    expect(calls[0]?.url).toBe("https://ingest.example.test/admin/source-authority/fence");
    expect(calls[0]?.body.source_id).toBe("src_x");
    expect(calls[0]?.body.fence_token).toMatch(/^[a-f0-9]{32}$/);
    expect(fence).toEqual({ sourceId: "src_x", fenceToken: calls[0]?.body.fence_token });
  });

  it("propagates an admin non-2xx so auth mutations cannot commit", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeFetch: typeof fetch = (async () => (
      new Response('{"error":"provider-private-response"}', { status: 503 })
    )) as typeof fetch;

    await expect(requireEdgeSourceFence("src_x", {
      fetchImpl: fakeFetch,
      env: {
        INGEST_ADMIN_URL: "https://ingest.example.test",
        INGEST_ADMIN_TOKEN: "tk",
      },
    })).rejects.toThrow(/edge_admin_http_503/);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("provider-private-response");
    errorSpy.mockRestore();
  });

  it("propagates transport failures while best-effort invalidation still swallows them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const options = {
      fetchImpl: fakeFetch,
      env: {
        INGEST_ADMIN_URL: "https://ingest.example.test",
        INGEST_ADMIN_TOKEN: "tk",
      },
    };

    await expect(requireEdgeSourceFence("src_x", options))
      .rejects.toThrow(/edge_admin_transport_failed/);
    await expect(invalidateEdgeSourceCache("src_x", options)).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe("requireEdgeSourceAuthoritySync", () => {
  it("loads committed Postgres state before releasing the fence", async () => {
    dbQueryMock.mockResolvedValueOnce({ rows: [sourceRow({ secret_token_hash: "committed-hash" })] });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: typeof fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await requireEdgeSourceAuthoritySync(
      { sourceId: "src_1", fenceToken: "fence_token_00000001" },
      "ws_1",
      {
        fetchImpl: fakeFetch,
        env: {
          INGEST_ADMIN_URL: "https://ingest.example.test",
          INGEST_ADMIN_TOKEN: "tk",
        },
      },
    );

    expect(calls[0]?.url).toBe("https://ingest.example.test/admin/source-authority/sync");
    expect(calls[0]?.body).toMatchObject({
      source_id: "src_1",
      fence_token: "fence_token_00000001",
      source: { source_id: "src_1", secret_token: "committed-hash" },
    });
  });

  it("publishes null after a committed deletion", async () => {
    dbQueryMock.mockResolvedValueOnce({ rows: [] });
    let body: Record<string, unknown> | undefined;
    const fakeFetch: typeof fetch = (async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await requireEdgeSourceAuthoritySync(
      { sourceId: "src_1", fenceToken: "fence_token_00000001" },
      "ws_1",
      {
        fetchImpl: fakeFetch,
        env: { INGEST_ADMIN_URL: "https://ingest.example.test", INGEST_ADMIN_TOKEN: "tk" },
      },
    );
    expect(body?.source).toBeNull();
  });
});

describe("rowToEdgePayload signing-secret fail-closed behavior", () => {
  const originalMasterKey = process.env.CREDENTIALS_MASTER_KEY;

  beforeAll(() => {
    process.env.CREDENTIALS_MASTER_KEY = MASTER_KEY;
  });

  afterAll(() => {
    if (originalMasterKey === undefined) delete process.env.CREDENTIALS_MASTER_KEY;
    else process.env.CREDENTIALS_MASTER_KEY = originalMasterKey;
  });

  it("keeps an intentionally unsigned custom source token-only", async () => {
    const payload = await rowToEdgePayload(sourceRow());
    expect(payload.provider).toBe("custom");
    expect(payload.signing_secret).toBeUndefined();
    expect(payload.signing_secret_previous).toBeUndefined();
  });

  it("refuses to downgrade a configured custom-HMAC source when its secret is corrupt", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(rowToEdgePayload(sourceRow({
      signing_secret_ciphertext: Buffer.alloc(8),
    }))).rejects.toThrow(/current_signing_secret_decrypt_failed/);
    errorSpy.mockRestore();
  });

  it("refuses a partial rotation when the current secret decrypts but the previous one does not", async () => {
    const current = await encryptSourceSigningSecret("whsec_current", "ws_1", "src_1");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(rowToEdgePayload(sourceRow({
      provider: "stripe",
      signing_secret_ciphertext: current.ciphertext,
      signing_secret_previous_ciphertext: Buffer.alloc(8),
    }))).rejects.toThrow(/previous_signing_secret_decrypt_failed/);
    errorSpy.mockRestore();
  });
});
