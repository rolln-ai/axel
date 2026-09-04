import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  MAX_API_JSON_BODY_BYTES,
  readJsonBody,
} from "../lib/api-router";

describe("public API JSON body boundary", () => {
  it("returns a fixed parse error without echoing submitted content", async () => {
    const marker = "customer-secret-marker";
    const request = new NextRequest("https://app.example.test/api/v1/sources", {
      method: "POST",
      body: `{"name":"${marker}"`,
    });

    const result = await readJsonBody(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: string; code: string };
    expect(body).toEqual({ error: "Body isn't valid JSON.", code: "invalid_body" });
    expect(JSON.stringify(body)).not.toContain(marker);
  });

  it("rejects a declared oversized body before parsing it", async () => {
    const request = new NextRequest("https://app.example.test/api/v1/sources", {
      method: "POST",
      headers: { "content-length": String(MAX_API_JSON_BODY_BYTES + 1) },
      body: "{}",
    });

    const result = await readJsonBody(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.response.status).toBe(413);
    await expect(result.response.json()).resolves.toEqual({
      error: "Request body exceeds the allowed size.",
      code: "request_too_large",
    });
  });

  it("caps streamed bodies even without a content-length header", async () => {
    const request = new NextRequest("https://app.example.test/api/v1/sources", {
      method: "POST",
      body: `"${"x".repeat(MAX_API_JSON_BODY_BYTES)}"`,
    });

    const result = await readJsonBody(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.response.status).toBe(413);
    await expect(result.response.json()).resolves.toMatchObject({
      code: "request_too_large",
    });
  });
});
