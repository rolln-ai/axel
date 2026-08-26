import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeSafeOutboundDispatcher,
  safeOutboundFetch,
  unsafeRemoteAddressReason,
} from "../src/safe-outbound-fetch.js";

afterAll(async () => {
  await closeSafeOutboundDispatcher();
});

describe("safe outbound socket guard", () => {
  it.each(["127.0.0.1", "169.254.169.254", "::1", "::ffff:7f00:1", "febf::1"])(
    "rejects a socket connected to %s",
    (address) => {
      expect(unsafeRemoteAddressReason(address)).toMatch(/^ssrf_blocked:/);
    },
  );

  it("allows a public remote address", () => {
    expect(unsafeRemoteAddressReason("93.184.216.34")).toBeNull();
  });

  it("closes a loopback socket before sending an HTTP request", async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.end("internal-only");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    await expect(safeOutboundFetch(`http://127.0.0.1:${address.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"secret":"webhook-body"}').buffer,
      redirect: "manual",
    })).rejects.toThrow(/ssrf_blocked/);
    expect(requests).toBe(0);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
