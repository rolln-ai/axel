import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createSafeLookup,
  createSafePgStream,
  createSafePgStreamForLookup,
} from "../src/safe-dns.js";

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

describe("safe DNS lookup", () => {
  it("pins a public answer", async () => {
    const lookup = createSafeLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(runLookup(lookup, "receiver.example")).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });

  it("rejects the whole answer set when one record is private", async () => {
    const lookup = createSafeLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(runLookup(lookup, "rebind.example")).rejects.toThrow(/ssrf_blocked/);
  });

  it("supports all-address lookups without returning unchecked records", async () => {
    const lookup = createSafeLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    await expect(runLookup(lookup, "receiver.example", { all: true })).resolves.toEqual({
      address: [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
      family: undefined,
    });
  });

  it("blocks node-postgres before a loopback socket is opened", async () => {
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
      server.close((closeError) => (closeError ? reject(closeError) : resolve())),
    );
  });

  it("blocks a literal loopback target even when Node bypasses DNS lookup", async () => {
    let accepted = 0;
    const server = createServer((socket) => {
      accepted += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const socket = createSafePgStream() as import("node:net").Socket;
    const error = new Promise<Error>((resolve) => socket.once("error", resolve));
    socket.connect(address.port, "127.0.0.1");
    await expect(error).resolves.toMatchObject({ message: expect.stringContaining("ssrf_blocked") });
    expect(accepted).toBe(0);
    await new Promise<void>((resolve, reject) =>
      server.close((closeError) => (closeError ? reject(closeError) : resolve())),
    );
  });

  it("blocks object-form Unix socket destinations", async () => {
    const socket = createSafePgStream() as import("node:net").Socket;
    const error = new Promise<Error>((resolve) => socket.once("error", resolve));
    socket.connect({ path: "/var/run/postgresql/.s.PGSQL.5432" });
    await expect(error).resolves.toMatchObject({ message: expect.stringContaining("ssrf_blocked") });
  });

  it("does not mistake node-postgres's config object for a DNS lookup function", async () => {
    const socket = createSafePgStream({ host: "database.example" }) as import("node:net").Socket;
    const error = new Promise<Error>((resolve) => socket.once("error", resolve));
    socket.connect(5432, "localhost");
    await expect(error).resolves.toMatchObject({ message: expect.stringContaining("ssrf_blocked") });
  });
});
