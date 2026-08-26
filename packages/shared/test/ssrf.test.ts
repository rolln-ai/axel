import { describe, expect, it, vi } from "vitest";
import {
  assertResolvedHostSafe,
  connectionHostSsrfReason,
  isPrivateOrUnsafeIp,
  validateDestinationUrl,
} from "../src/ssrf.js";

describe("IPv6 SSRF protection", () => {
  it.each([
    "http://[::ffff:127.0.0.1]/internal",
    "http://[::ffff:7f00:1]/internal",
    "http://[::ffff:a9fe:a9fe]/metadata",
  ])("blocks IPv4-mapped private addresses after URL canonicalization: %s", (url) => {
    expect(validateDestinationUrl(url)).toMatch(/private|link-local|metadata/i);
  });

  it.each(["fe80::1", "fea0::1", "febf:ffff::1"])(
    "blocks the complete fe80::/10 link-local range: %s",
    (address) => {
      expect(isPrivateOrUnsafeIp(address)).toBe(true);
    },
  );

  it("does not classify public IPv6 or public IPv4-mapped IPv6 as private", () => {
    expect(isPrivateOrUnsafeIp("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateOrUnsafeIp("::ffff:808:808")).toBe(false);
  });

  it("rejects a hostname when DNS returns a canonical mapped-private address", async () => {
    const lookup = vi.fn(async () => [{ address: "::ffff:7f00:1" }]);
    await expect(assertResolvedHostSafe("attacker.example", lookup)).resolves.toMatch(/private|loopback|metadata/i);
  });
});

describe("destination credential storage", () => {
  it("rejects URL userinfo so credentials cannot be retained in plaintext config", () => {
    expect(validateDestinationUrl("https://alice:hunter2@receiver.example/webhook"))
      .toMatch(/must not include username or password credentials/i);
  });
});

describe("hostname SSRF normalization", () => {
  it.each(["http://localhost./", "http://api.localhost./private"])(
    "blocks an absolute localhost name: %s",
    (url) => {
      expect(validateDestinationUrl(url)).toMatch(/private|link-local|metadata/i);
    },
    );
  });

  it.each([
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "5f00::1",
    "fec0::1",
  ])("blocks non-global and transition IPv6 space: %s", (address) => {
    expect(isPrivateOrUnsafeIp(address)).toBe(true);
  });

describe("special-use IPv4 ranges", () => {
  it.each([
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
  ])("blocks non-public address %s", (address) => {
    expect(isPrivateOrUnsafeIp(address)).toBe(true);
  });
});

describe("connection URI SSRF validation", () => {
  it("checks a Postgres host query override", () => {
    expect(
      connectionHostSsrfReason("postgres://user:pass@database.example/db?host=127.0.0.1"),
    ).toMatch(/private|loopback/i);
  });

  it("checks every repeated Postgres host override", () => {
    expect(
      connectionHostSsrfReason(
        "postgres://user:pass@database.example/db?host=public.example&host=169.254.169.254",
      ),
    ).toMatch(/private|metadata/i);
  });

  it("blocks local Unix socket overrides", () => {
    expect(
      connectionHostSsrfReason(
        "postgres://user:pass@database.example/db?host=%2Fvar%2Frun%2Fpostgresql",
      ),
    ).toMatch(/local socket/i);
  });
});
