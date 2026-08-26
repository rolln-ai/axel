import { describe, expect, it, vi } from "vitest";
import { invalidateEdgeSourceCache } from "../lib/edge-invalidation";

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
