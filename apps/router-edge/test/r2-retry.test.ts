import { describe, expect, it, vi } from "vitest";
import { getRawEventWithRetry } from "../src/index.ts";

describe("router R2 retry", () => {
  it("retries Cloudflare R2 10043 and returns the eventual object", async () => {
    const object = { arrayBuffer: vi.fn() } as unknown as R2ObjectBody;
    const get = vi.fn()
      .mockRejectedValueOnce(
        new Error(
          "get: Please look at https://www.cloudflarestatus.com for issues or contact customer support. (10043)",
        ),
      )
      .mockResolvedValueOnce(object);

    await expect(
      getRawEventWithRetry({ get } as unknown as R2Bucket, "events/ws/event.json"),
    ).resolves.toBe(object);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent R2 error", async () => {
    const get = vi.fn().mockRejectedValue(new Error("get: authentication failed"));

    await expect(
      getRawEventWithRetry({ get } as unknown as R2Bucket, "events/ws/event.json"),
    ).rejects.toThrow("authentication failed");
    expect(get).toHaveBeenCalledOnce();
  });
});
