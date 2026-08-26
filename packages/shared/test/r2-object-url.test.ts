import { describe, expect, it } from "vitest";
import {
  cloudflareR2ObjectUrl,
  encodeCloudflareR2ObjectKey,
} from "../src/r2-object-url.ts";

describe("Cloudflare R2 object URLs", () => {
  it("keeps key slashes literal while encoding each path segment", () => {
    expect(encodeCloudflareR2ObjectKey("events/ws 1/evt?#%.json")).toBe(
      "events/ws%201/evt%3F%23%25.json",
    );
  });

  it("preserves leading, trailing, and repeated slashes in the object key", () => {
    expect(encodeCloudflareR2ObjectKey("/events//one/")).toBe("/events//one/");
  });

  it("constructs the account-scoped Cloudflare API URL", () => {
    expect(cloudflareR2ObjectUrl("acct", "raw-bucket", "queue-spill/ws/one.json")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/raw-bucket/objects/queue-spill/ws/one.json",
    );
  });

  it("rejects dot segments before URL parsing can normalize them outside /objects", () => {
    expect(() => encodeCloudflareR2ObjectKey("events/../secret")).toThrow(
      "invalid_r2_object_key",
    );
    expect(() => encodeCloudflareR2ObjectKey("events/./secret")).toThrow(
      "invalid_r2_object_key",
    );
  });
});
