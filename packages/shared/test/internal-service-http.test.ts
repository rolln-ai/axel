import { describe, expect, it, vi } from "vitest";
import {
  readBoundedJsonResponse,
  resolveInternalServiceEndpoint,
  validateInternalServiceEndpoint,
} from "../src/internal-service-http.js";

describe("internal service URLs", () => {
  it("builds only a fixed path from a bare HTTPS origin", () => {
    expect(resolveInternalServiceEndpoint(
      "https://delivery.example.test/",
      "/internal/source",
    )).toBe("https://delivery.example.test/internal/source");
    expect(validateInternalServiceEndpoint(
      "https://delivery.example.test/internal/heartbeat",
      "/internal/heartbeat",
    )).toBe("https://delivery.example.test/internal/heartbeat");
  });

  it.each([
    "http://delivery.example.test",
    "https://user:password@delivery.example.test",
    "https://delivery.example.test/prefix",
    "https://delivery.example.test?redirect=attacker.example",
    "https://delivery.example.test#fragment",
    "https://localhost",
    "https://127.0.0.1",
  ])("rejects an unsafe base URL: %s", (value) => {
    expect(() => resolveInternalServiceEndpoint(value, "/internal/source"))
      .toThrow("internal_service_url_invalid");
  });

  it("rejects override path drift", () => {
    expect(() => validateInternalServiceEndpoint(
      "https://delivery.example.test/deliver",
      "/internal/heartbeat",
    )).toThrow("internal_service_url_invalid");
  });
});

describe("bounded internal JSON", () => {
  it("parses a response below the byte ceiling", async () => {
    await expect(readBoundedJsonResponse(
      new Response('{"ok":true}', { headers: { "content-length": "11" } }),
      64,
    )).resolves.toEqual({ ok: true });
  });

  it("cancels a declared oversized response before reading it", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      headers: new Headers({ "content-length": "1024" }),
      body: { cancel },
    } as unknown as Response;
    await expect(readBoundedJsonResponse(response, 64))
      .rejects.toThrow("internal_service_response_too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops a chunked response at the byte ceiling", async () => {
    await expect(readBoundedJsonResponse(new Response("x".repeat(65)), 64))
      .rejects.toThrow("internal_service_response_too_large");
  });
});
