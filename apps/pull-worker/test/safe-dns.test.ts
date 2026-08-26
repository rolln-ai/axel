import { describe, expect, it } from "vitest";
import { createSafeLookup, createSafePgStream } from "../src/safe-dns.js";

function runLookup(lookup: ReturnType<typeof createSafeLookup>, hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(hostname, {}, (error, address) => {
      if (error) reject(error);
      else resolve(address as string);
    });
  });
}

describe("pull-worker safe DNS", () => {
  it("pins a public address", async () => {
    const lookup = createSafeLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(runLookup(lookup, "database.example")).resolves.toBe("93.184.216.34");
  });

  it("rejects a private address returned for a public-looking hostname", async () => {
    const lookup = createSafeLookup(async () => [{ address: "10.0.0.8", family: 4 }]);
    await expect(runLookup(lookup, "database.example")).rejects.toThrow(/ssrf_blocked/);
  });

  it("rejects a mixed public and private DNS answer set", async () => {
    const lookup = createSafeLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(runLookup(lookup, "rebind.example")).rejects.toThrow(/ssrf_blocked/);
  });

  it("does not mistake node-postgres's config object for a DNS lookup function", async () => {
    const socket = createSafePgStream({ host: "database.example" }) as import("node:net").Socket;
    const error = new Promise<Error>((resolve) => socket.once("error", resolve));
    socket.connect(5432, "localhost");
    await expect(error).resolves.toMatchObject({ message: expect.stringContaining("ssrf_blocked") });
  });
});
