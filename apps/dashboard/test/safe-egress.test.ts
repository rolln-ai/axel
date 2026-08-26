import http from "node:http";
import { createServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeSafeDashboardDispatcher,
  createSafeLookup,
  createSafePgStream,
  createSafePgStreamForLookup,
  safeDashboardFetch,
  unsafeRemoteAddressReason,
} from "../lib/safe-egress";

function runLookup(
  lookup: ReturnType<typeof createSafeLookup>,
  hostname: string,
  options: { all?: boolean; family?: number } = {},
): Promise<{ address: string | Array<{ address: string; family: number }>; family?: number }> {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address: address as string | Array<{ address: string; family: number }>, family });
    });
  });
}

afterAll(async () => {
  await closeSafeDashboardDispatcher();
});

describe("dashboard safe egress", () => {
  it("pins a public DNS answer", async () => {
    const lookup = createSafeLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(runLookup(lookup, "receiver.example")).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });

  it("rejects a mixed DNS answer set containing a private address", async () => {
    const lookup = createSafeLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(runLookup(lookup, "rebind.example")).rejects.toThrow(/ssrf_blocked/);
  });

  it.each(["127.0.0.1", "169.254.169.254", "::1", "::ffff:7f00:1", "febf::1"])(
    "rejects an HTTP socket connected to %s",
    (address) => {
      expect(unsafeRemoteAddressReason(address)).toMatch(/^ssrf_blocked:/);
    },
  );

  it("closes a loopback HTTP socket before sending the request", async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.end("internal-only");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    await expect(safeDashboardFetch(`http://127.0.0.1:${address.port}/`, {
      method: "POST",
      body: "webhook-body",
      redirect: "manual",
    })).rejects.toThrow(/ssrf_blocked/);
    expect(requests).toBe(0);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  });

  it("blocks node-postgres before a private DNS answer opens a socket", async () => {
    let accepted = 0;
    const server = createServer((socket) => {
      accepted += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const lookup = createSafeLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
    const socket = createSafePgStreamForLookup(lookup) as import("node:net").Socket;
    const error = new Promise<Error>((resolve) => socket.once("error", resolve));
    socket.connect(address.port, "database.example");
    await expect(error).resolves.toMatchObject({ message: expect.stringContaining("ssrf_blocked") });
    expect(accepted).toBe(0);
    await new Promise<void>((resolve, reject) =>
      server.close((closeError) => closeError ? reject(closeError) : resolve()),
    );
  });

  it("does not mistake node-postgres's config object for a DNS lookup function", async () => {
    const socket = createSafePgStream({ host: "database.example" }) as import("node:net").Socket;
    const error = new Promise<Error>((resolve) => socket.once("error", resolve));
    socket.connect(5432, "localhost");
    await expect(error).resolves.toMatchObject({ message: expect.stringContaining("ssrf_blocked") });
  });
});
