import { afterEach, describe, expect, it, vi } from "vitest";
import { authLogin } from "../src/commands/auth.js";
import { CliApiError, makeClient, normalizeApiBaseUrl } from "../src/api-client.js";
import type { CliConfig } from "../src/config.js";

function config(apiBase: string): CliConfig {
  return {
    token: "axe_pat_test-token",
    api_base: apiBase,
    workspace_id: "ws_test",
    workspace_name: "Test",
    token_name: "test",
    minted_at: new Date(0).toISOString(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe("API base validation", () => {
  it("normalizes HTTPS URLs to their origin", () => {
    expect(normalizeApiBaseUrl("https://axel.example.test/path?ignored=1")).toBe(
      "https://axel.example.test",
    );
  });

  it.each([
    "http://axel.example.test",
    "http://localhost.example.test",
    "https://user:secret@axel.example.test",
    "https://axel.example.test/#fragment",
    "https://axel.example.test/#",
  ])("rejects an unsafe API base before constructing a client: %s", (apiBase) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => makeClient(config(apiBase))).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
  ])("allows an exact HTTP loopback development origin: %s", (apiBase) => {
    expect(normalizeApiBaseUrl(apiBase)).toBe(apiBase);
  });

  it("rejects an unsafe login base before using the supplied PAT", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await authLogin({ "api-base": "http://axel.example.test", token: "axe_pat_secret" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(64);
  });
});

describe("authenticated requests", () => {
  it("does not follow redirects with a bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", {
        status: 302,
        headers: { location: "https://other.example.test/v1/cli/me" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient(config("https://axel.example.test")).get("/v1/cli/me"))
      .rejects.toBeInstanceOf(CliApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://axel.example.test/v1/cli/me",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
