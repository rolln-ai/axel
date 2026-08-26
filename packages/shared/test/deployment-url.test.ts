import { describe, expect, it } from "vitest";
import {
  resolveIngestBaseUrl,
  resolveRawPayloadBucket,
} from "../src/deployment-url.js";

describe("resolveIngestBaseUrl", () => {
  it("uses an explicitly configured URL and removes trailing slashes", () => {
    expect(resolveIngestBaseUrl({ AXEL_INGEST_URL: "https://ingest.example.test///" })).toBe(
      "https://ingest.example.test",
    );
  });

  it("removes an adversarial run of trailing slashes in linear time", () => {
    expect(
      resolveIngestBaseUrl({
        AXEL_INGEST_URL: `https://ingest.example.test${"/".repeat(10_000)}`,
      }),
    ).toBe("https://ingest.example.test");
  });

  it("keeps the Axel Cloud default for the hosted deployment", () => {
    expect(resolveIngestBaseUrl({})).toBe("https://ingest.axelapp.ai");
  });

  it("fails closed when a self-hosted deployment omits its ingest URL", () => {
    expect(() =>
      resolveIngestBaseUrl({
        AXEL_DEPLOYMENT_MODE: "self-hosted",
        NEXT_PUBLIC_AXEL_INGEST_URL: "https://ingest.axelapp.ai",
      }),
    ).toThrow(/AXEL_INGEST_URL is required/);
  });

  it("accepts the private self-host ingest setting", () => {
    expect(
      resolveIngestBaseUrl({
        AXEL_DEPLOYMENT_MODE: "self-hosted",
        AXEL_INGEST_URL: "https://ingest.selfhost.example",
      }),
    ).toBe("https://ingest.selfhost.example");
  });

  it("rejects plaintext remote self-host ingest while allowing localhost development", () => {
    expect(() =>
      resolveIngestBaseUrl({
        AXEL_DEPLOYMENT_MODE: "self-hosted",
        AXEL_INGEST_URL: "http://ingest.selfhost.example",
      }),
    ).toThrow(/must use https:\/\//);
    expect(
      resolveIngestBaseUrl({
        AXEL_DEPLOYMENT_MODE: "self-hosted",
        AXEL_INGEST_URL: "http://localhost:8787/",
      }),
    ).toBe("http://localhost:8787");
  });

  it("rejects non-HTTP URLs and embedded credentials", () => {
    expect(() => resolveIngestBaseUrl({ AXEL_INGEST_URL: "file:///tmp/webhooks" })).toThrow(
      /http:\/\//,
    );
    expect(() =>
      resolveIngestBaseUrl({ AXEL_INGEST_URL: "https://user:secret@ingest.example.test" }),
    ).toThrow(/embedded credentials/);
  });
});

describe("resolveRawPayloadBucket", () => {
  it("uses an explicitly configured bucket", () => {
    expect(resolveRawPayloadBucket({ RAW_PAYLOAD_BUCKET: " axel-selfhost-raw " })).toBe(
      "axel-selfhost-raw",
    );
  });

  it("keeps the Axel Cloud default for hosted processes", () => {
    expect(resolveRawPayloadBucket({})).toBe("axel-events-raw");
  });

  it("fails closed when a self-hosted process omits its bucket", () => {
    expect(() =>
      resolveRawPayloadBucket({ AXEL_DEPLOYMENT_MODE: "self-hosted" }),
    ).toThrow(/RAW_PAYLOAD_BUCKET is required/);
  });
});
